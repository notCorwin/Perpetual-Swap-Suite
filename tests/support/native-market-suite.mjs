import assert from 'node:assert/strict'
import { join } from 'node:path'
import { installChartPriceReader } from '../helpers/chart-price-label.mjs'
import { MarketStore } from '../../electron/services/market-store.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import { createNativeExchange, nativeIntervals } from '../helpers/native-exchange.mjs'
import { waitForAsyncCondition } from '../../scripts/async-readiness.mjs'

const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'

// Launch is supplied by the caller so the same acceptance runs against the
// guarded packaged artifact or source runtime, with identical assertions.
// Initial completed history is seeded; all subsequent quotes, candles, repairs
// and reconnect acknowledgments traverse native loopback HTTP/WebSocket.
export async function runNativeMarketAcceptance({ directory, launch, close = electron => electron?.close(), onDiagnostic = () => {}, timeoutMS = 90_000 }) {
  const exchange = await createNativeExchange({ holdMissingBase: true })
  let electron, page, expired = false, timer, closingElectron, closeTask
  const stopApp = () => {
    if (!electron) return Promise.resolve()
    if (closingElectron === electron) return closeTask
    closingElectron = electron
    return closeTask = Promise.resolve().then(() => close(electron))
  }
  const timeoutError = new Error(`Native market acceptance exceeded its ${timeoutMS}ms work budget.`)
  const observations = []
  let selectedTimeframe = '15m'
  const readPrice = () => page.evaluate(timeframe => {
    const workspace = document.querySelector('[data-chart-panel]')
    const chart = workspace?.querySelector(`svg[data-rendered-timeframe="${timeframe}"]`)?.closest('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
    const svg = chart?.querySelector('svg[data-rendered-inst]')
    const label = svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? ''
    return { chartInstId: chart?.getAttribute('data-chart-inst'), chartTimeframe: chart?.getAttribute('data-chart-timeframe'),
      svgInstId: svg?.getAttribute('data-rendered-inst'), svgTimeframe: svg?.getAttribute('data-rendered-timeframe'),
      svgEnd: Number(svg?.getAttribute('data-rendered-end')), label, labelPercentage: window.__chartPriceLabel(label),
      snapshot: snapshot ? { instId: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour,
        liveHour: snapshot.liveBar?.hour, livePrice: snapshot.liveBar?.close, liveOpen: snapshot.liveBar?.open, confirmed: snapshot.liveBar?.confirmed,
        priceObservedAt: snapshot.priceObservedAt, realtimeState: snapshot.realtimeState, generation: snapshot.generation,
        completed: snapshot.bars.length } : null,
      status: [...(workspace?.querySelectorAll('[role="status"]') ?? [])].map(value => value.textContent?.trim()),
    }
  }, selectedTimeframe)
  const readCandles = ({ instId, timeframe, from, through }) => page.evaluate(async query => window.radarDesktop.request({ e2e: {
    action: 'readCandles', instrument: query.instId, timeframe: query.timeframe, from: query.from, through: query.through,
  } }), { instId, timeframe, from, through })
  const assertPrice = async expected => {
    try {
      await page.waitForFunction(expected => {
        const workspace = document.querySelector('[data-chart-panel]')
        const chart = workspace?.querySelector(`svg[data-rendered-timeframe="${expected.timeframe}"]`)?.closest('[data-chart-inst]'), snapshot = chart?.__chartSnapshot
        const svg = chart?.querySelector('svg[data-rendered-inst]')
        const label = svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? ''
        const percentage = window.__chartPriceLabel(label)
        const change = (snapshot?.liveBar?.close / snapshot?.liveBar?.open - 1) * 100
        const sign = change > 0 ? '+' : change < 0 ? '-' : ''
        return snapshot?.instId === expected.instId && snapshot.timeframe === expected.timeframe
          && snapshot.liveBar?.hour === expected.hour && snapshot.liveBar.close === expected.close
          && percentage !== null && Math.abs(percentage - change) < 0.005001
          && (sign ? label.startsWith(sign) : !label.startsWith('+') && !label.startsWith('-'))
          && svg?.getAttribute('data-rendered-inst') === expected.instId && svg.getAttribute('data-rendered-timeframe') === expected.timeframe
          && Number(svg.getAttribute('data-rendered-end')) === expected.hour
          && snapshot.priceObservedAt >= expected.sentAt && snapshot.realtimeState === 'live'
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
    selectedTimeframe = timeframe
    await page.waitForFunction(({ instId, timeframe }) => {
      const chart = document.querySelector(`svg[data-rendered-timeframe="${timeframe}"]`)?.closest('[data-chart-inst]')
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
    await assertPrice({ instId, timeframe: chartTimeframe, hour: expectedHour, close, sentAt: event.sentAt })
    return event
  }
  const work = (async () => {
    try {
      // No forming candle, catalog projection or prepared response is seeded.
      const metadata = await MetadataStore.open(directory)
      try {
        const preferences = structuredClone(DEFAULT_PREFERENCES)
        for (const condition of Object.values(preferences.liquidity)) condition.enabled = false
        metadata.updateSettings(preferences)
      } finally { metadata.close() }
      const store = await MarketStore.open(join(directory, 'MarketData'))
      try { await store.appendCandles(exchange.closedCandles) } finally { await store.close() }

      if (expired) throw timeoutError
      ;({ electron, page } = await launch(exchange.environment))
      if (expired) { await stopApp(); throw timeoutError }
      await page.waitForLoadState('domcontentloaded')
      await installChartPriceReader(page)
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
      await page.locator(`svg[data-rendered-inst="${btc}"][data-rendered-timeframe="15m"]`).waitFor({ state: 'visible' })
      await exchange.waitForHeldHistory()

      // Current native prices must remain usable while the missing completed
      // coarse parent is still being acquired through the held native REST fallback.
      for (const close of [133.25, 134.5, 135.75]) {
        exchange.sendTicker(btc, close)
        await sendBasePrice(btc, '15m', close, 10)
      }
      const heldPrice = await readPrice(), released = await exchange.releaseHistory()
      assert.equal(released, 1, 'The missing 15m parent should be repaired directly without downloading an unselected 5m child.')
      // HTTP response completion precedes the backend's durable write. Await the
      // closed fact through the public read bridge before inspecting its values.
      const repairedParent = await waitForAsyncCondition(async () => {
        const rows = await readCandles({ instId: btc, timeframe: '15m', from: exchange.deferredEnd, through: exchange.deferredEnd })
        return rows.length === 1 && rows[0].confirmed ? rows : null
      }, { description: 'the durable repaired 15m parent' })
      assert.equal(repairedParent.length, 1)
      assert.equal(repairedParent[0].confirmed, true)
      assert.equal(repairedParent[0].volume, 300, 'Native 15m fallback volume must equal the sum of its three 5m source candles.')
      assert.equal(repairedParent[0].baseVolume, 300)
      assert.equal(repairedParent[0].quoteVolume, 30_000)
      // Prove the durable parent was supplied by the 15m fallback before the
      // concurrently requested 5m child can repair and re-derive that parent.
      assert.deepEqual(await readCandles({ instId: btc, timeframe: '5m', from: exchange.missingBaseEnd, through: exchange.missingBaseEnd }), [])
      await exchange.releaseBaseHistory()
      const missingBase = await readCandles({ instId: btc, timeframe: '5m', from: exchange.missingBaseEnd, through: exchange.missingBaseEnd })
      if (missingBase.length) {
        assert.equal(missingBase.length, 1)
        assert.equal(missingBase[0].confirmed, true)
        assert.ok(exchange.requests.some(value => value.path === '/market/history-candles' && value.parameters.instId === btc
          && value.parameters.bar === '5m' && Number(value.parameters.after) === exchange.missingBaseEnd + nativeIntervals['5m']),
        'A simultaneously selected 5m chart must acquire its missing child from the native source.')
      }
      // Observe actual UI commits during the source completion, without issuing a
      // chart refresh that could conceal a push-delivery or cache invalidation bug.
      for (let index = 0; index < 10; index++) {
        const current = await readPrice()
        assert.equal(current.snapshot.livePrice, 135.75, `A delayed history repair rewound the visible native price: ${JSON.stringify(current)}`)
        assert.ok(Number.isFinite(current.labelPercentage) && Math.abs(current.labelPercentage - (current.snapshot.livePrice / current.snapshot.liveOpen - 1) * 100) < 0.005001)
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
        const workspace = document.querySelector('[data-chart-panel]')
        const snapshot = workspace?.querySelector('svg[data-rendered-timeframe="15m"]')?.closest('[data-chart-inst]')?.__chartSnapshot
        return snapshot?.instId === 'BTC-USDT-SWAP' && snapshot.timeframe === '15m'
          && snapshot.realtimeState === 'stale'
          && document.querySelector('[data-market-status] [data-chart-shared-status-item="15m"]')?.textContent?.includes('Cached price')
      }, null, { timeout: 2_000 })
      const disconnectedPrice = await readPrice()
      assert.equal(disconnectedPrice.snapshot.livePrice, 136.25, 'Disconnecting must preserve the actual last price while revoking its live status.')
      assert.ok(Number.isFinite(disconnectedPrice.labelPercentage) && Math.abs(disconnectedPrice.labelPercentage - (disconnectedPrice.snapshot.livePrice / disconnectedPrice.snapshot.liveOpen - 1) * 100) < 0.005001)
      await exchange.waitForBusinessReconnect()
      assert.deepEqual(exchange.businessSubscriptions(), [], 'The reconnect ACK hold must keep canonical 5m ownership pending.')
      exchange.resumeBusinessAcknowledgments()
      await exchange.waitForSubscription(btc, 'candle5m')
      assert.deepEqual(exchange.businessSubscriptions(), [`candle5m:${btc}`, `candle5m:${eth}`].sort())
      const finalEvent = await sendBasePrice(btc, '15m', 137.5, 12)

      const formingParent = Math.floor(finalEvent.timestamp / nativeIntervals['15m']) * nativeIntervals['15m'], formingLedger = []
      for (const [timeframe, timestamp] of [['5m', finalEvent.timestamp], ['15m', formingParent]]) {
        const unconfirmed = await readCandles({ instId: btc, timeframe, from: timestamp, through: timestamp })
        assert.deepEqual(unconfirmed, [], `Native forming ${timeframe} prices must remain in memory rather than entering the completed-candle ledger.`)
        formingLedger.push({ instId: btc, timeframe, timestamp, durableRows: unconfirmed.length })
      }
      const indicatorEvidence = await page.evaluate(async ({ instId, endHour }) => {
        const chart = await window.radarDesktop.request({ chartHistory: { instId, timeframe: '15m', endHour } })
        return chart.bars.find(bar => bar.hour === endHour)
      }, { instId: btc, endHour: exchange.deferredEnd })
      assert.ok(indicatorEvidence, 'The packaged chart worker must return the repaired completed candle.')
      // Every completed input before this point is a flat 100 close, typical price
      // 100, high 101, low 99 and positive base volume. No production calculation
      // or rendered output supplies these expected mathematical values.
      for (const field of ['open', 'close', 'ema', 'bollUpper', 'bollMiddle', 'bollLower']) {
        assert.ok(Number.isFinite(indicatorEvidence[field]) && Math.abs(indicatorEvidence[field] - 100) <= 1e-10 * 100, `${field} must match the independent flat-source expectation: ${indicatorEvidence[field]}`)
      }
      for (const field of ['roc', 'maroc', 'bbw']) assert.equal(indicatorEvidence[field], 0, `${field} must be zero for flat closes.`)
      for (const field of ['rsi6', 'rsi12', 'rsi24']) assert.equal(indicatorEvidence[field], 50, `${field} must be 50 for flat closes.`)
      assert.equal(indicatorEvidence.atrPercent, 2, 'True range 2 / close 100 must produce ATR%=2.')
      assert.deepEqual(exchange.errors, [])
      const evidence = { integration: 'native-ws-to-selected-svg', source: 'loopback OKX envelopes over native WebSocket; real market/SQLite/workers/IPC/renderer', observations: observations.length, deferredResponses: released, nativeDisconnects: disconnected, presentation, indicators: indicatorEvidence, priceObservations: observations, formingLedger,
        inputs: { historicalSeed: 'Completed canonical 5m candles seeded before launch, with one deliberate gap.',
          historicalRows: exchange.closedCandles.length, transport: 'Quotes, forming candles, historical repair and reconnect acknowledgments use native loopback HTTP/WebSocket.',
          expectedValues: 'Independent fixed fixture prices and flat-source mathematical values.' } }
      onDiagnostic(evidence)
      return evidence
    } catch (error) {
      onDiagnostic({ source: 'native-live-price-failure', errors: exchange.errors, requests: exchange.requests,
        chart: page ? await readPrice().catch(() => null) : null, observations })
      throw error
    } finally {
      await exchange.releaseHistory().catch(() => {})
      await exchange.releaseBaseHistory().catch(() => {})
      try { await stopApp() } finally { await exchange.close() }
    }
  })()
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(timeoutError) }, timeoutMS)
    })])
  } finally {
    clearTimeout(timer)
    if (expired) {
      // Closing sockets and the app cancels pending browser/network waits.
      // Drain the scenario before its caller removes the isolated profile.
      try { await stopApp() } finally {
        await exchange.close()
        await work.catch(() => {})
      }
    }
  }
}
