import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { MarketStore } from '../../electron/services/market-store.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import { createNativeExchange } from '../helpers/native-exchange.mjs'

const frames = ['1H', '15m', '5m'], btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'

test('default multi-timeframe charts synchronize time navigation and retain selectable indicators', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-multiframe-'))
  const exchange = await createNativeExchange()
  let electron
  try {
    const metadata = await MetadataStore.open(directory)
    try {
      const preferences = structuredClone(DEFAULT_PREFERENCES)
      for (const condition of Object.values(preferences.liquidity)) condition.enabled = false
      metadata.updateSettings(preferences)
    } finally { metadata.close() }
    const store = await MarketStore.open(join(directory, 'MarketData'))
    try { await store.appendCandles(exchange.closedCandles) } finally { await store.close() }
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: directory, ...exchange.environment } })
    const page = await electron.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    assert.deepEqual(await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() }
    }), { visible: false, focused: false, focusable: false })
    await page.locator(`[aria-label="View ${btc} chart"]`).click()
    console.log('multiframe: selected BTC')
    await exchange.releaseHistory()
    const ready = async instId => {
      await page.waitForFunction(instId => {
        const charts = [...document.querySelectorAll('[data-chart-inst]')]
        return charts.length === 3 && charts.every((chart, index) => chart.__chartSnapshot?.instId === instId
          && chart.__chartSnapshot.timeframe === ['1H', '15m', '5m'][index]
          && chart.querySelector('svg[data-rendered-inst]')?.getAttribute('data-rendered-inst') === instId)
      }, instId, { timeout: 30_000 })
      assert.deepEqual(await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => svg.dataset.renderedTimeframe)), frames)
      assert.equal(await page.locator('[data-chart-panel-header]').count(), 0)
      assert.deepEqual(await page.locator('[data-shared-chart-legend] [data-chart-legend]').evaluateAll(swatches => swatches.map(swatch => swatch.dataset.chartLegend)), ['VWAP(14)', 'BOLL(20,2)'])
      assert.equal(await page.locator('[data-chart-price-scale="relative"]').count(), 1)
      assert.equal(await page.locator('[data-chart-indicator="rsi6"]').count(), 0)
      assert.equal(await page.locator('[data-chart-indicator="ema"], [data-chart-legend="EMA(200)"]').count(), 0)
      for (const field of ['vwap', 'bollUpper', 'bollMiddle', 'bollLower']) assert.equal(await page.locator(`[data-chart-indicator="${field}"]`).count(), 3)
      const positions = await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => ({ top: svg.getBoundingClientRect().top, height: svg.getBoundingClientRect().height })))
      assert.ok(positions.every(position => position.height > 60))
      assert.ok(positions[0].top < positions[1].top && positions[1].top < positions[2].top)
    }
    const live = async (instId, close, volume) => {
      await Promise.all(['candle5m', 'tickers'].map(channel => exchange.waitForSubscription(instId, channel)))
      exchange.sendTicker(instId, close)
      const event = exchange.sendCandle(instId, '5m', { close, volume })
      await page.waitForFunction(({ instId, close, sentAt }) => {
        const quote = document.querySelector('[data-shared-chart-price]')?.textContent
        const charts = [...document.querySelectorAll('[data-chart-inst]')]
        return Number(quote?.replaceAll(',', '')) === close && charts.length === 3 && charts.every(chart => {
          const snapshot = chart.__chartSnapshot
          const svg = chart.querySelector('svg[data-rendered-inst]')
          const referenceOpen = snapshot?.liveBar?.open
          const label = svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? ''
          const percent = /^([+-]?[\d,]+(?:\.\d+)?)% [↑↓]$/.exec(label)?.[1]
          return snapshot?.instId === instId && snapshot.liveBar?.close === close && snapshot.priceObservedAt >= sentAt
            && percent !== undefined && Math.abs(Number(percent.replaceAll(',', '')) - (close / referenceOpen - 1) * 100) < 0.005001
            && svg.querySelector('[data-chart-countdown]')
        })
      }, { instId, close, sentAt: event.sentAt }, { timeout: 15_000 }).catch(async error => {
        console.error('multiframe live diagnostics:', await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => ({
          timeStart: chart.dataset.chartTimeStart, timeEnd: chart.dataset.chartTimeEnd,
          loading: chart.dataset.chartLoading, liveBar: chart.__chartSnapshot?.liveBar,
          label: chart.querySelector('[data-chart-price-label-value]')?.textContent,
          countdown: Boolean(chart.querySelector('[data-chart-countdown]')),
          observedAt: chart.__chartSnapshot?.priceObservedAt,
        }))))
        throw error
      })
    }
    console.log('multiframe: history released')
    await ready(btc)
    console.log('multiframe: three ready')
    await live(btc, 139.25, 20)
    exchange.sendTicker(btc, 138.75)
    await page.waitForFunction(() => {
      const charts = [...document.querySelectorAll('[data-chart-inst]')]
      return Number(document.querySelector('[data-shared-chart-price]')?.textContent) === 138.75 && charts.length === 3
        && charts.every(chart => {
          const svg = chart.querySelector('svg[data-rendered-inst]'), snapshot = chart.__chartSnapshot
          const referenceOpen = snapshot?.liveBar?.open
          const percent = /^([+-]?[\d,]+(?:\.\d+)?)% [↑↓]$/.exec(svg?.querySelector('[data-chart-price-label-value]')?.textContent ?? '')?.[1]
          return percent !== undefined && Math.abs(Number(percent.replaceAll(',', '')) - (139.25 / referenceOpen - 1) * 100) < 0.005001
            && chart.querySelector('[data-chart-countdown]')
        })
    })
    await live(btc, 140.5, 30)
    // Read the actual time at each plot edge, not candle indexes: each
    // timeframe uses a different number of candles for the same duration.
    const timeRanges = () => page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => ({
      start: Number(chart.dataset.chartTimeStart), end: Number(chart.dataset.chartTimeEnd),
    })))
    const waitForAlignedRanges = async (previous, mode) => {
      await page.waitForFunction(({ previous, mode }) => {
        const charts = [...document.querySelectorAll('[data-chart-inst]')]
        if (charts.length !== 3) return false
        const ranges = charts.map(chart => ({ start: Number(chart.dataset.chartTimeStart), end: Number(chart.dataset.chartTimeEnd) }))
        if (!ranges.every(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)) return false
        // Each renderer can update in a separate frame. One second is well
        // below a candle in any displayed timeframe and accommodates the live clock.
        if (ranges.some(range => Math.abs(range.start - ranges[0].start) > 1000 || Math.abs(range.end - ranges[0].end) > 1000)) return false
        if (!previous) return true
        return mode === 'pan' ? ranges.every((range, index) => range.end < previous[index].end - 1000)
          : ranges.every((range, index) => range.end - range.start < (previous[index].end - previous[index].start) * 0.95)
      }, { previous, mode }, { timeout: 30_000 })
      return timeRanges()
    }
    const initial = await waitForAlignedRanges(null, null)
    await page.locator('[data-chart-plot]').nth(1).evaluate(plot => plot.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true })))
    const panned = await waitForAlignedRanges(initial, 'pan')
    // Zoom a different chart and check all three absolute ranges, including
    // their left edges and durations, instead of their bar-spacing values.
    await page.locator('[data-chart-plot]').nth(2).evaluate(plot => {
      const rect = plot.getBoundingClientRect()
      plot.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -19, clientX: rect.left + rect.width * .4, bubbles: true, cancelable: true }))
    })
    const zoomed = await waitForAlignedRanges(panned, 'zoom')
    assert.ok(zoomed.every(range => range.end - range.start < panned[0].end - panned[0].start))
    // Return to the latest time and verify all three resume native updates.
    await page.locator('[data-chart-plot]').first().evaluate(plot => plot.dispatchEvent(new WheelEvent('wheel', { deltaX: 100_000, bubbles: true, cancelable: true })))
    await waitForAlignedRanges(null, null)
    await live(btc, 141.25, 35)
    await page.evaluate(() => { location.hash = '#/settings/workspace' })
    await page.getByRole('main', { name: 'Settings', exact: true }).getByRole('link', { name: 'Settings', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-multi-timeframe-charts] svg[data-rendered-inst]').length === 3)
    await page.locator('[data-chart-plot]').first().evaluate(plot => plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-inst]')].every(chart => chart.__chartSnapshot?.instId === 'ETH-USDT-SWAP'))
    await ready(eth)
    console.log('multiframe: ETH ready')
    await live(eth, 142.75, 40)
    await page.getByRole('button', { name: 'Indicators', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('svg[data-rendered-inst]').length === 1 && document.querySelector('[data-chart-panel-header="rsi"]'))
    for (const [timeframe, label] of [['1H', '1h'], ['15m', '15m'], ['5m', '5m']]) {
      await page.locator('[aria-label="Chart timeframe"] button').filter({ hasText: new RegExp(`^${label}$`, 'i') }).click()
      await page.waitForFunction(timeframe => document.querySelector('svg[data-rendered-inst]')?.getAttribute('data-rendered-timeframe') === timeframe, timeframe)
      assert.equal(await page.locator('[data-chart-indicator="ema"], [data-chart-legend="EMA(200)"]').count(), 0)
      for (const field of ['vwap', 'bollUpper', 'bollMiddle', 'bollLower']) assert.equal(await page.locator(`[data-chart-indicator="${field}"]`).count(), 1)
    }
    await page.waitForFunction(async () => (await window.radarDesktop.request({ preferences: { action: 'read' } })).chartDisplayMode === 'indicators')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[data-chart-display-mode="indicators"]'))
    await page.getByRole('button', { name: 'Multi-timeframe', exact: true }).click()
    await page.waitForFunction(async () => (await window.radarDesktop.request({ preferences: { action: 'read' } })).chartDisplayMode === 'multi')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelectorAll('svg[data-rendered-inst]').length === 3)
    assert.deepEqual(errors, [])
    assert.deepEqual(exchange.businessSubscriptions(), [`candle5m:${btc}`, `candle5m:${eth}`].sort())
  } finally {
    if (electron) await electron.close()
    await exchange.close()
    await rm(directory, { recursive: true, force: true })
  }
})
