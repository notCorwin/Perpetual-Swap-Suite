import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { MarketStore } from '../../electron/services/market-store.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import { createNativeExchange, nativeIntervals } from '../helpers/native-exchange.mjs'

const root = new URL('../..', import.meta.url).pathname
const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'

// This is deliberately a market-value regression, not a foreground paint budget.
// Hidden windows still exercise native sockets, workers, IPC, React and SVG.
test('native WebSocket prices reach the selected SVG and survive a same-volume older REST reply', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-native-live-price-'))
  const exchange = await createNativeExchange()
  let electron, page
  const observations = []
  const readPrice = () => page.evaluate(() => {
    const workspace = document.querySelector('[data-chart-workspace]')
    const chart = workspace?.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
    const svg = chart?.querySelector('svg[data-rendered-inst]')
    const label = svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? ''
    return { chartInstId: chart?.getAttribute('data-chart-inst'), chartTimeframe: chart?.getAttribute('data-chart-timeframe'),
      svgInstId: svg?.getAttribute('data-rendered-inst'), svgTimeframe: svg?.getAttribute('data-rendered-timeframe'),
      svgEnd: Number(svg?.getAttribute('data-rendered-end')), label, labelPrice: Number(label.split(/\s/)[0].replaceAll(',', '')),
      snapshot: snapshot ? { instId: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour,
        liveHour: snapshot.liveBar?.hour, livePrice: snapshot.liveBar?.close, confirmed: snapshot.liveBar?.confirmed,
        priceObservedAt: snapshot.priceObservedAt, realtimeState: snapshot.realtimeState, generation: snapshot.generation,
        completed: snapshot.bars.length } : null,
      status: [...(workspace?.querySelectorAll('[role="status"]') ?? [])].map(value => value.textContent?.trim()),
    }
  })
  const assertPrice = async expected => {
    try {
      await page.waitForFunction(expected => {
        const workspace = document.querySelector('[data-chart-workspace]')
        const chart = workspace?.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
        const svg = chart?.querySelector('svg[data-rendered-inst]')
        const price = Number((svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? '').split(/\s/)[0].replaceAll(',', ''))
        return snapshot?.instId === expected.instId && snapshot.timeframe === expected.timeframe
          && snapshot.liveBar?.hour === expected.hour && snapshot.liveBar.close === expected.close && price === expected.close
          && svg?.getAttribute('data-rendered-inst') === expected.instId && svg.getAttribute('data-rendered-timeframe') === expected.timeframe
          && Number(svg.getAttribute('data-rendered-end')) === expected.hour
          && snapshot.priceObservedAt >= expected.sentAt && snapshot.realtimeState === 'live'
          && [...workspace.querySelectorAll('[role="status"]')].some(value => value.textContent?.trim() === 'Live price')
      }, expected, { timeout: 10_000 })
    } catch (error) {
      throw new Error(`Native price failed to reach the selected chart. Expected ${JSON.stringify(expected)}; actual ${JSON.stringify(await readPrice())}; exchange ${JSON.stringify({ errors: exchange.errors, requests: exchange.requests })}`, { cause: error })
    }
    const actual = await readPrice()
    assert.equal(actual.snapshot.confirmed, false)
    assert.ok(Date.now() - actual.snapshot.priceObservedAt < 30_000)
    observations.push({ expected, actual })
    return actual
  }
  const select = async (instId, timeframe) => {
    await page.locator(`[aria-label="View ${instId} chart"]`).click()
    await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: new RegExp(`^${timeframe}$`, 'i') }).click()
    await page.waitForFunction(({ instId, timeframe }) => {
      const chart = document.querySelector('[data-chart-inst]')
      return chart?.__chartSnapshot?.instId === instId && chart.__chartSnapshot.timeframe === timeframe
    }, { instId, timeframe })
  }
  try {
    // No forming candle, catalog projection or prepared response is seeded.
    const metadata = await MetadataStore.open(directory)
    try {
      const preferences = structuredClone(DEFAULT_PREFERENCES)
      preferences.chartTimeframe = '15m'
      for (const condition of Object.values(preferences.liquidity)) condition.enabled = false
      metadata.updateSettings(preferences)
    } finally { metadata.close() }
    const store = await MarketStore.open(join(directory, 'MarketData'))
    try { await store.appendCandles(exchange.closedCandles) } finally { await store.close() }

    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1',
        PERPETUAL_SWAP_TEST_UI: process.env.PERPETUAL_SWAP_TEST_UI ?? 'background',
        PERPETUAL_SWAP_USER_DATA: directory, ...exchange.environment } })
    page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).waitFor()
    const presentation = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused() }
    })
    if (process.env.PERPETUAL_SWAP_TEST_UI !== 'foreground') assert.deepEqual(presentation, { visible: false, focused: false })
    await Promise.all([btc, eth].flatMap(instId => Object.keys(nativeIntervals).map(timeframe => exchange.waitForSubscription(instId, `candle${timeframe}`))))
    await select(btc, '15m')
    await exchange.waitForHeldLatest()

    // Three real native revisions share the REST response's cumulative volume.
    // Older source completion must not overwrite a newer socket observation.
    for (const close of [133.25, 134.5, 135.75]) {
      exchange.sendTicker(btc, close)
      await assertPrice(exchange.sendCandle(btc, '15m', { close, volume: 10 }))
    }
    const heldPrice = await readPrice(), released = await exchange.releaseLatest()
    assert.ok(released > 0, 'The test must complete a genuinely deferred native REST response.')
    // Await the missing closed fact through the public read bridge. Its commit
    // occurs in the same latest-source task that previously replayed stale live.
    await page.waitForFunction(async expected => {
      const rows = await window.radarDesktop.request({ e2e: { action: 'readCandles', instrument: expected.instId,
        timeframe: '15m', from: expected.timestamp, through: expected.timestamp } })
      return rows.length === 1 && rows[0].confirmed
    }, { instId: btc, timestamp: exchange.deferredEnd })
    // Observe actual UI commits during the source completion, without issuing a
    // chart refresh that could conceal a push-delivery or cache invalidation bug.
    for (let index = 0; index < 10; index++) {
      const current = await readPrice()
      assert.equal(current.snapshot.livePrice, 135.75, `A late same-volume REST reply rewound the visible native price: ${JSON.stringify(current)}`)
      assert.equal(current.labelPrice, 135.75)
      assert.equal(current.snapshot.liveHour, heldPrice.snapshot.liveHour)
      assert.ok(current.snapshot.priceObservedAt >= heldPrice.snapshot.priceObservedAt)
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // Native period and contract identities must survive cold admission and
    // warm revisits; distinct prices make a relabeled old chart fail numerically.
    await select(eth, '15m')
    await assertPrice(exchange.sendCandle(eth, '15m', { close: 512.5, volume: 10 }))
    await select(btc, '5m')
    await assertPrice(exchange.sendCandle(btc, '5m', { close: 143.5, volume: 10 }))
    await select(btc, '15m')
    await assertPrice(exchange.sendCandle(btc, '15m', { close: 136.25, volume: 11 }))

    // A quiet last price must stop claiming live continuity as soon as the
    // business socket closes. Hold real reconnect ACKs so this state cannot be
    // skipped merely because the fixture reconnects faster than React commits.
    const disconnected = await exchange.disconnectBusiness({ holdAcknowledgments: true })
    assert.ok(disconnected > 0)
    await page.waitForFunction(() => {
      const workspace = document.querySelector('[data-chart-workspace]')
      const snapshot = workspace?.querySelector('[data-chart-inst]')?.__chartSnapshot
      return snapshot?.instId === 'BTC-USDT-SWAP' && snapshot.timeframe === '15m'
        && snapshot.realtimeState === 'stale'
        && [...workspace.querySelectorAll('[role="status"]')].some(value => value.textContent?.trim() === 'Cached price')
    }, null, { timeout: 2_000 })
    const disconnectedPrice = await readPrice()
    assert.equal(disconnectedPrice.labelPrice, 136.25, 'Disconnecting must preserve the actual last price while revoking its live status.')
    await exchange.waitForBusinessReconnect()
    exchange.resumeBusinessAcknowledgments()
    await exchange.waitForSubscription(btc, 'candle15m')
    await assertPrice(exchange.sendCandle(btc, '15m', { close: 137.5, volume: 12 }))

    const unconfirmed = await page.evaluate(async ({ instId, hour }) => window.radarDesktop.request({ e2e: {
      action: 'readCandles', instrument: instId, timeframe: '15m', from: hour, through: hour,
    } }), { instId: btc, hour: Math.floor(Date.now() / nativeIntervals['15m']) * nativeIntervals['15m'] })
    assert.deepEqual(unconfirmed, [], 'Native forming prices must remain in memory rather than entering the completed-candle ledger.')
    assert.deepEqual(exchange.errors, [])
    t.diagnostic(JSON.stringify({ integration: 'native-ws-to-selected-svg', source: 'loopback OKX envelopes over native WebSocket; real market/SQLite/workers/IPC/renderer', observations: observations.length, deferredResponses: released, nativeDisconnects: disconnected, presentation }))
  } catch (error) {
    t.diagnostic(JSON.stringify({ source: 'native-live-price-failure', errors: exchange.errors, requests: exchange.requests,
      chart: page ? await readPrice().catch(() => null) : null, observations }))
    throw error
  } finally {
    await exchange.releaseLatest().catch(() => {})
    await electron?.close()
    await exchange.close()
    await rm(directory, { recursive: true, force: true })
  }
})
