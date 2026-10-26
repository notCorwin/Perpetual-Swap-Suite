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
const expectedAggregate = (rows, timeframe, timestamp) => ({
  instrument: rows[0].instrument, timeframe, timestamp,
  open: rows[0].open, high: Math.max(...rows.map(row => row.high)), low: Math.min(...rows.map(row => row.low)), close: rows.at(-1).close,
  volume: rows.reduce((total, row) => total + row.volume, 0),
  baseVolume: rows.reduce((total, row) => total + row.baseVolume, 0),
  quoteVolume: rows.reduce((total, row) => total + row.quoteVolume, 0), confirmed: true,
})

test('backend collection, gap repair, and all-period preparation run independently of a renderer', { timeout: 90_000 }, async () => {
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
    await Promise.all(ids.map(instId => exchange.waitForSubscription(instId, 'candle5m')))
    assert.deepEqual(exchange.businessSubscriptions(), ids.map(instId => `candle5m:${instId}`).sort(),
      'The backend must collect every candidate on 5m and derive both coarse periods locally.')
    await backend.request({ chartFocus: { id: 'e2e-btc-15m', target: { instId: ids[0], timeframe: '15m' } } })
    await exchange.waitForHeldHistory()
    assert.equal(await exchange.releaseHistory(), 1, 'Only the missing coarse parent should need a native REST fallback.')
    assert.deepEqual(exchange.requests.filter(value => value.path === '/market/history-candles' && value.parameters.instId === ids[0]
      && value.parameters.bar === '5m' && Number(value.parameters.after) === exchange.missingBaseEnd + nativeIntervals['5m']), [],
    'A selected 15m chart must not download its unselected interior 5m child.')
    const basePrefix = await backend.request({ e2e: { action: 'readCandles', instrument: ids[0], timeframe: '5m',
      from: exchange.seededBaseFrom, through: exchange.seededBaseThrough } })
    const gapIndex = (exchange.missingBaseEnd - exchange.seededBaseFrom) / nativeIntervals['5m']
    assert.equal(basePrefix.length, exchange.baseCandleCount - 1)
    assert.ok(basePrefix.every((row, index) => row.confirmed && row.timestamp === exchange.seededBaseFrom
      + (index < gapIndex ? index : index + 1) * nativeIntervals['5m']),
    'The canonical 5m gap must remain explicit while 15m is selected.')
    for (const instId of ids) for (const timeframe of Object.keys(nativeIntervals)) {
      await backend.request({ chartFocus: { id: `e2e-${instId}-${timeframe}`, target: { instId, timeframe } } })
      await waitFor(() => {
        const frame = published.get(`${instId}:${timeframe}`)
        return frame?.bars.length === 96 && frame.indicatorState === 'ready'
          && frame.oiState === 'unavailable' && frame.takerState === 'unavailable'
      }, `publish the locally prepared ${timeframe} frame and its successful-empty source status for ${instId}`)
      if (instId === ids[0] && timeframe === '5m') {
        await waitFor(async () => {
          const rows = await backend.request({ e2e: { action: 'readCandles', instrument: ids[0], timeframe: '5m',
            from: exchange.missingBaseEnd, through: exchange.missingBaseEnd } })
          return rows[0]?.confirmed === true
        }, 'repair the 5m gap only after the 5m chart owns that history range')
      }
    }
    assert.deepEqual(exchange.businessSubscriptions(), ids.map(instId => `candle5m:${instId}`).sort(),
      'Focusing local coarse frames must not install coarse native WebSocket subscriptions.')

    const repaired = await backend.request({ e2e: { action: 'readCandles', instrument: ids[0], timeframe: '15m', from: exchange.deferredEnd, through: exchange.deferredEnd } })
    assert.equal(repaired.length, 1)
    assert.equal(repaired[0].confirmed, true)
    const changedAt = Math.floor(exchange.asOf / nativeIntervals['1H']) * nativeIntervals['1H'] - nativeIntervals['5m']
    const coarseBefore = new Map()
    for (const timeframe of ['15m', '1H']) {
      const step = nativeIntervals[timeframe], timestamp = Math.floor(changedAt / step) * step
      const rows = await backend.request({ e2e: { action: 'readCandles', instrument: ids[1], timeframe, from: timestamp, through: timestamp } })
      assert.equal(rows.length, 1, `The seeded ${timeframe} aggregate must exist before the 5m correction.`)
      coarseBefore.set(timeframe, rows[0])
    }
    const changed = exchange.sendCandle(ids[1], '5m', { timestamp: changedAt, close: 551.25, volume: 100, confirmed: true })
    assert.ok(changed.volume > 0 && changed.baseVolume > 0 && changed.quoteVolume > 0)
    await waitFor(async () => {
      const rows = await backend.request({ e2e: { action: 'readCandles', instrument: ids[1], timeframe: '5m', from: changed.timestamp, through: changed.timestamp } })
      return rows[0]?.close === changed.close
    }, 'persist an unselected contract update')
    await waitFor(() => published.get(`${ids[1]}:5m`)?.bars.some(bar => bar.hour === changed.timestamp && bar.close === changed.close), 'recalculate the unselected native frame')
    for (const timeframe of ['15m', '1H']) {
      const step = nativeIntervals[timeframe], timestamp = Math.floor(changed.timestamp / step) * step
      const children = exchange.closedCandles.filter(row => row.instrument === ids[1] && row.timeframe === '5m'
        && row.timestamp >= timestamp && row.timestamp < timestamp + step).map(row => row.timestamp === changed.timestamp
        ? { ...row, close: changed.close, high: Math.max(row.open, changed.close) + 1, low: Math.min(row.open, changed.close) - 1,
          volume: changed.volume, baseVolume: changed.baseVolume, quoteVolume: changed.quoteVolume } : row)
      assert.equal(children.length, step / nativeIntervals['5m'], `${timeframe} must have a complete canonical 5m source bucket.`)
      const expected = expectedAggregate(children, timeframe, timestamp)
      // The confirmed 5m write is observable before the serialized coarse
      // materialization finishes. Wait for that derived write before checking
      // the exact canonical aggregate; the 5m publication alone is not its
      // completion signal.
      await waitFor(async () => {
        const rows = await backend.request({ e2e: { action: 'readCandles', instrument: ids[1], timeframe, from: timestamp, through: timestamp } })
        return rows.length === 1 && ['open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']
          .some(field => !Object.is(rows[0][field], coarseBefore.get(timeframe)[field]))
      }, `materialize the canonical ${timeframe} aggregate after its 5m correction`)
      const rows = await backend.request({ e2e: { action: 'readCandles', instrument: ids[1], timeframe, from: timestamp, through: timestamp } })
      assert.equal(rows.length, 1)
      for (const field of ['open', 'high', 'low', 'close', 'volume', 'baseVolume', 'quoteVolume', 'confirmed']) {
        assert.equal(rows[0][field], expected[field], `${timeframe} ${field} must match the canonical 5m aggregate.`)
      }
    }

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
