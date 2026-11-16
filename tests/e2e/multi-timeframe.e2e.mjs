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
      assert.equal(await page.locator('[data-chart-indicator="ema"]').count(), 3)
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
          && Number(label.split(/\s/)[0].replaceAll(',', '')) === close
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
    await page.evaluate(() => { location.hash = '#/settings/workspace' })
    await page.getByRole('link', { name: 'Back to markets' }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-multi-timeframe-charts] svg[data-rendered-inst]').length === 3)
    await page.locator('[data-chart-plot]').first().evaluate(plot => plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-inst]')].every(chart => chart.__chartSnapshot?.instId === 'ETH-USDT-SWAP'))
    await ready(eth)
    console.log('multiframe: ETH ready')
    await live(eth, 142.75, 40)
    await page.getByRole('button', { name: 'Indicators', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('svg[data-rendered-inst]').length === 1 && document.querySelector('[data-chart-panel-header="rsi"]'))
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
