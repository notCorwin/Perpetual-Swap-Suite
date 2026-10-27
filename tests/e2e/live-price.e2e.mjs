import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { MarketStore } from '../../electron/services/market-store.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import { createNativeExchange, nativeIntervals } from '../helpers/native-exchange.mjs'
import { waitForAsyncCondition } from '../../scripts/async-readiness.mjs'

const root = new URL('../..', import.meta.url).pathname
const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'

// This is deliberately a market-value regression, not a foreground paint budget.
// Hidden windows still exercise native sockets, workers, IPC, React and SVG.
test('native WebSocket prices reach the selected SVG and survive delayed durable history repair', { timeout: 90_000 }, async t => {
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
  const readCandles = ({ instId, timeframe, from, through }) => page.evaluate(async query => window.radarDesktop.request({ e2e: {
    action: 'readCandles', instrument: query.instId, timeframe: query.timeframe, from: query.from, through: query.through,
  } }), { instId, timeframe, from, through })
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
  const sendBasePrice = async (instId, chartTimeframe, close, volume) => {
    const { currentTimestamp: timestamp, closed } = exchange.closeElapsedCandles()
    if (closed.length) {
      await waitForAsyncCondition(async () => {
        const durable = await Promise.all(closed.map(event => readCandles({ instId: event.instId, timeframe: '5m',
          from: event.timestamp, through: event.timestamp })))
        return durable.every((rows, index) => rows.length === 1 && rows[0].confirmed
          && rows[0].timestamp === closed[index].timestamp)
      }, { description: `${closed.length} elapsed native 5m candles to commit`, timeoutMS: 15_000 })
    }
    const interval = nativeIntervals['5m']
    const start = Math.floor(timestamp / nativeIntervals[chartTimeframe]) * nativeIntervals[chartTimeframe]
    const prefixCount = (timestamp - start) / interval
    const prefix = prefixCount ? await readCandles({ instId, timeframe: '5m', from: start, through: timestamp - interval }) : []
    assert.equal(prefix.length, prefixCount, `The confirmed 5m prefix for the ${chartTimeframe} forming candle must be complete.`)
    assert.ok(prefix.every((row, index) => row.confirmed && row.timestamp === start + index * interval),
      `The confirmed 5m prefix for the ${chartTimeframe} forming candle must be continuous.`)
    const event = exchange.sendCandle(instId, '5m', { close, volume, timestamp })
    assert.ok(event.volume > 0 && event.baseVolume > 0 && event.quoteVolume > 0, 'Forming 5m input quantities must be positive.')
    const expectedHour = chartTimeframe === '5m' ? timestamp : start
    return assertPrice({ instId, timeframe: chartTimeframe, hour: expectedHour, close, sentAt: event.sentAt })
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
    await Promise.all([btc, eth].map(instId => exchange.waitForSubscription(instId, 'candle5m')))
    assert.deepEqual(exchange.businessSubscriptions(), [`candle5m:${btc}`, `candle5m:${eth}`].sort(),
      'Every candidate must use the canonical native 5m stream; coarse candles are derived locally.')
    // Backend qualification exposes both rows while the missing chart source repairs.
    await page.locator(`[aria-label="View ${btc} chart"]`).waitFor({ state: 'visible' })
    await page.locator(`[aria-label="View ${eth} chart"]`).waitFor({ state: 'visible' })
    await select(btc, '15m')
    await page.locator(`[data-chart-inst="${btc}"]`).waitFor({ state: 'visible' })
    await exchange.waitForHeldHistory()

    // Current native prices must remain usable while the missing completed
    // coarse parent is still being acquired through the held native REST fallback.
    for (const close of [133.25, 134.5, 135.75]) {
      exchange.sendTicker(btc, close)
      await sendBasePrice(btc, '15m', close, 10)
    }
    const heldPrice = await readPrice(), released = await exchange.releaseHistory()
    assert.equal(released, 1, 'The missing 15m parent should be repaired directly without downloading an unselected 5m child.')
    const repairedParent = await readCandles({ instId: btc, timeframe: '15m', from: exchange.deferredEnd, through: exchange.deferredEnd })
    assert.equal(repairedParent.length, 1)
    assert.equal(repairedParent[0].confirmed, true)
    assert.equal(repairedParent[0].volume, 300, 'Native 15m fallback volume must equal the sum of its three 5m source candles.')
    assert.equal(repairedParent[0].baseVolume, 300)
    assert.equal(repairedParent[0].quoteVolume, 30_000)
    const missingBase = await readCandles({ instId: btc, timeframe: '5m', from: exchange.missingBaseEnd, through: exchange.missingBaseEnd })
    assert.deepEqual(missingBase, [], 'A coarse fallback must not fabricate the missing canonical 5m child.')
    // Await the missing closed fact through the public read bridge. Its durable
    // commit must preserve the separately observed native forming price.
    await waitForAsyncCondition(async () => {
      const rows = await readCandles({ instId: btc, timeframe: '15m', from: exchange.deferredEnd, through: exchange.deferredEnd })
      return rows.length === 1 && rows[0].confirmed
    }, { description: 'the durable repaired 15m parent' })
    // Observe actual UI commits during the source completion, without issuing a
    // chart refresh that could conceal a push-delivery or cache invalidation bug.
    for (let index = 0; index < 10; index++) {
      const current = await readPrice()
      assert.equal(current.snapshot.livePrice, 135.75, `A delayed history repair rewound the visible native price: ${JSON.stringify(current)}`)
      assert.equal(current.labelPrice, 135.75)
      assert.equal(current.snapshot.liveHour, heldPrice.snapshot.liveHour)
      assert.ok(current.snapshot.priceObservedAt >= heldPrice.snapshot.priceObservedAt)
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // Native period and contract identities must survive cold admission and
    // warm revisits; distinct prices make a relabeled old chart fail numerically.
    await select(eth, '15m')
    await sendBasePrice(eth, '15m', 512.5, 10)
    await select(btc, '5m')
    await waitForAsyncCondition(async () => {
      const rows = await readCandles({ instId: btc, timeframe: '5m', from: exchange.missingBaseEnd, through: exchange.missingBaseEnd })
      return rows.length === 1 && rows[0].confirmed
    }, { description: 'the selected 5m chart to durably repair its interior gap', timeoutMS: 15_000 })
    assert.ok(exchange.requests.some(value => value.path === '/market/history-candles' && value.parameters.instId === btc
      && value.parameters.bar === '5m' && Number(value.parameters.after) === exchange.missingBaseEnd + nativeIntervals['5m']),
    'Selecting the 5m chart must own the repair of its historical interior gap.')
    await sendBasePrice(btc, '5m', 143.5, 10)
    await select(btc, '15m')
    await sendBasePrice(btc, '15m', 136.25, 11)

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
    assert.deepEqual(exchange.businessSubscriptions(), [], 'The reconnect ACK hold must keep canonical 5m ownership pending.')
    exchange.resumeBusinessAcknowledgments()
    await exchange.waitForSubscription(btc, 'candle5m')
    assert.deepEqual(exchange.businessSubscriptions(), [`candle5m:${btc}`, `candle5m:${eth}`].sort())
    await sendBasePrice(btc, '15m', 137.5, 12)

    const unconfirmed = await readCandles({ instId: btc, timeframe: '15m', from: Math.floor(Date.now() / nativeIntervals['15m']) * nativeIntervals['15m'],
      through: Math.floor(Date.now() / nativeIntervals['15m']) * nativeIntervals['15m'] })
    assert.deepEqual(unconfirmed, [], 'Native forming prices must remain in memory rather than entering the completed-candle ledger.')
    assert.deepEqual(exchange.errors, [])
    t.diagnostic(JSON.stringify({ integration: 'native-ws-to-selected-svg', source: 'loopback OKX envelopes over native WebSocket; real market/SQLite/workers/IPC/renderer', observations: observations.length, deferredResponses: released, nativeDisconnects: disconnected, presentation }))
  } catch (error) {
    t.diagnostic(JSON.stringify({ source: 'native-live-price-failure', errors: exchange.errors, requests: exchange.requests,
      chart: page ? await readPrice().catch(() => null) : null, observations }))
    throw error
  } finally {
    await exchange.releaseHistory().catch(() => {})
    await electron?.close()
    await exchange.close()
    await rm(directory, { recursive: true, force: true })
  }
})
