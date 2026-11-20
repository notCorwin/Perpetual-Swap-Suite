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
    // The right edge represents the same time in every chart. Equal candle
    // widths mean the 1h, 15m and 5m plots cover different durations.
    const viewports = () => page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => ({
      start: Number(chart.dataset.chartTimeStart), end: Number(chart.dataset.chartTimeEnd),
      spacing: Number(chart.dataset.chartBarSpacing),
      width: Number(chart.querySelector('svg[data-chart-bar-width]')?.dataset.chartBarWidth),
    })))
    const waitForSynchronizedViewports = async (previous, mode) => {
      await page.waitForFunction(({ previous, mode }) => {
        const charts = [...document.querySelectorAll('[data-chart-inst]')]
        if (charts.length !== 3) return false
        const ranges = charts.map(chart => ({
          start: Number(chart.dataset.chartTimeStart), end: Number(chart.dataset.chartTimeEnd),
          spacing: Number(chart.dataset.chartBarSpacing),
          width: Number(chart.querySelector('svg[data-chart-bar-width]')?.dataset.chartBarWidth),
        }))
        if (!ranges.every(range => Number.isFinite(range.start) && Number.isFinite(range.end)
          && range.end > range.start && Number.isFinite(range.spacing) && range.spacing > 0
          && Number.isFinite(range.width) && range.width > 0)) return false
        if (ranges.some(range => Math.abs(range.end - ranges[0].end) > 1000
          || Math.abs(range.spacing - ranges[0].spacing) > 0.001
          || Math.abs(range.width - ranges[0].width) > 0.001)) return false
        const duration = range => range.end - range.start
        if (Math.abs(duration(ranges[0]) / duration(ranges[2]) - 12) > .01
          || Math.abs(duration(ranges[1]) / duration(ranges[2]) - 3) > .01) return false
        if (!previous) return true
        if (mode === 'pan') {
          const moves = ranges.map((range, index) => range.end - previous[index].end)
          return moves.every(move => move < -1000 && Math.abs(move - moves[0]) <= 2000)
            && ranges.every((range, index) => Math.abs(range.spacing - previous[index].spacing) < .001)
        }
        return ranges.every((range, index) => range.spacing > previous[index].spacing + .01
          && range.width > previous[index].width && duration(range) < duration(previous[index]) * .99)
      }, { previous, mode }, { timeout: 30_000 })
      return viewports()
    }
    const initial = await waitForSynchronizedViewports(null, null)
    await page.locator('[data-chart-plot]').nth(1).evaluate(plot => plot.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true })))
    const panned = await waitForSynchronizedViewports(initial, 'pan')
    // Zooming any one chart changes candle width in all three.
    await page.locator('[data-chart-plot]').nth(2).evaluate(plot => {
      const rect = plot.getBoundingClientRect()
      plot.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -19, clientX: rect.left + rect.width * .4, bubbles: true, cancelable: true }))
    })
    await waitForSynchronizedViewports(panned, 'zoom')
    // Return to the latest time and verify all three resume native updates.
    await page.locator('[data-chart-plot]').first().evaluate(plot => plot.dispatchEvent(new WheelEvent('wheel', { deltaX: 100_000, bubbles: true, cancelable: true })))
    await waitForSynchronizedViewports(null, null)
    await live(btc, 141.25, 35)
    await page.evaluate(() => { location.hash = '#/settings/workspace' })
    await page.getByRole('main', { name: 'Settings', exact: true }).getByRole('link', { name: 'Settings', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-multi-timeframe-charts] svg[data-rendered-inst]').length === 3)
    await page.locator('[data-chart-plot]').first().evaluate(plot => plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-inst]')].every(chart => chart.__chartSnapshot?.instId === 'ETH-USDT-SWAP'))
    await ready(eth)
    await waitForSynchronizedViewports(null, null)
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
