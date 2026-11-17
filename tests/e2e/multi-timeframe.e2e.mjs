import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { installChartPriceReader } from '../helpers/chart-price-label.mjs'
import { MarketStore } from '../../electron/services/market-store.js'
import { MetadataStore, DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import { createNativeExchange } from '../helpers/native-exchange.mjs'

const frames = ['1H', '15m', '5m'], btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP'

test('default multi-timeframe charts share native prices, isolate history and retain selectable indicators', { timeout: 120_000 }, async () => {
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
    await installChartPriceReader(page)
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
      assert.equal(await page.locator('[data-chart-panel-header]:not([data-chart-panel-header="price"])').count(), 0)
      assert.equal(await page.locator('[data-chart-indicator="rsi6"]').count(), 0)
      assert.equal(await page.locator('[data-chart-indicator="ema"], [data-chart-legend="EMA(200)"]').count(), 0)
      for (const field of ['vwap', 'bollUpper', 'bollMiddle', 'bollLower']) assert.equal(await page.locator(`[data-chart-indicator="${field}"]`).count(), 3)
      const positions = await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => ({ top: svg.getBoundingClientRect().top, height: svg.getBoundingClientRect().height })))
      assert.ok(positions.every(position => position.height > 60))
      assert.ok(positions[0].top < positions[1].top && positions[1].top < positions[2].top)
    }
    const live = async (instId, close, volume) => {
      await exchange.waitForSubscription(instId, 'candle5m')
      exchange.sendTicker(instId, close)
      const event = exchange.sendCandle(instId, '5m', { close, volume })
      await page.waitForFunction(({ instId, close, sentAt }) => [...document.querySelectorAll('[data-chart-inst]')].every(chart => {
        const snapshot = chart.__chartSnapshot
        const label = chart.querySelector('[data-chart-price-label-value]')?.textContent ?? ''
        return snapshot?.instId === instId && snapshot.liveBar?.close === close && snapshot.priceObservedAt >= sentAt
          && window.__chartPriceLabel(label) === close
      }), { instId, close, sentAt: event.sentAt }, { timeout: 15_000 })
    }
    console.log('multiframe: history released')
    await ready(btc)
    console.log('multiframe: three ready')
    await live(btc, 139.25, 20)
    await live(btc, 140.5, 30)
    // Each chart owns its own cursor; scrolling 15m must leave the other two live.
    const before = await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => chart.__chartSnapshot.endHour))
    await page.locator('[data-chart-plot]').nth(1).evaluate(plot => plot.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true })))
    await page.waitForFunction(before => {
      const charts = [...document.querySelectorAll('[data-chart-inst]')]
      return charts[1].__chartSnapshot.endHour < before[1] && charts[0].__chartSnapshot.endHour === before[0] && charts[2].__chartSnapshot.endHour === before[2]
    }, before)
    await page.waitForFunction(() => document.querySelectorAll('[data-chart-inst]')[1]?.dataset.chartLoading === 'false')
    await page.waitForTimeout(1000)
    // A partial wheel gesture moves existing paths; the path nodes and their
    // market-data geometry remain untouched until the viewport changes.
    const fractional = await page.locator('[data-chart-plot]').nth(1).evaluate(async plot => {
      const path = plot.querySelector('[data-chart-indicator="vwap"]')
      const content = path.closest('[data-chart-wheel-content]')
      const svg = path.closest('svg'), before = { d: path.getAttribute('d'), end: svg.dataset.renderedEnd }
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      plot.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, bubbles: true, cancelable: true }))
      await frame()
      const moved = Number(content.dataset.chartWheelOffset)
      const same = path === plot.querySelector('[data-chart-indicator="vwap"]') && before.d === path.getAttribute('d') && before.end === svg.dataset.renderedEnd
      plot.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, bubbles: true, cancelable: true }))
      await frame()
      return { moved, same, reversed: Number(content.dataset.chartWheelOffset), before, after: { d: path.getAttribute('d'), end: svg.dataset.renderedEnd }, sameNode: path === plot.querySelector('[data-chart-indicator="vwap"]') }
    })
    assert.ok(fractional.same, `Partial scrolling must retain the existing SVG path and geometry: ${JSON.stringify(fractional)}`)
    assert.notEqual(fractional.moved, 0, 'A cached adjacent candle permits immediate partial movement.')
    assert.equal(fractional.reversed, 0, 'Reversing the gesture returns to the original position.')
    // A zoomed historical viewport must return to the forming candle and
    // resume native WebSocket updates without retaining its fractional offset.
    const zoomSpacing = await page.locator('[data-chart-plot]').nth(1).evaluate(async plot => {
      const rect = plot.getBoundingClientRect()
      plot.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -19, clientX: rect.left + rect.width * .4, bubbles: true, cancelable: true }))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const spacing = Number(plot.closest('[data-chart-inst]').dataset.chartBarSpacing)
      plot.dispatchEvent(new WheelEvent('wheel', { deltaX: 100_000, bubbles: true, cancelable: true }))
      return spacing
    })
    await page.waitForFunction(() => {
      const chart = document.querySelectorAll('[data-chart-inst]')[1], snapshot = chart?.__chartSnapshot
      return snapshot?.liveBar && Number(chart.dataset.chartEnd) === snapshot.liveBar.hour
        && Number(chart.querySelector('svg[data-rendered-inst]').dataset.chartDomainEnd) === snapshot.liveBar.hour
    })
    await live(btc, 141.25, 35)
    assert.equal(await page.locator('[data-chart-inst]').nth(1).getAttribute('data-chart-bar-spacing'), String(zoomSpacing))
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
