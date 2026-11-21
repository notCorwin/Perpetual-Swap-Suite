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

test('multi-timeframe charts synchronize navigation and copy all three charts', { timeout: 120_000 }, async () => {
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
      assert.equal(await page.locator('[data-shared-chart-legend]').count(), 0)
      assert.equal(await page.locator('[data-chart-title]').count(), 1)
      assert.equal(await page.getByText('Multi-timeframe', { exact: true }).count(), 0)
      assert.equal(await page.locator('[data-chart-toolbar]').count(), 1)
      assert.equal(await page.locator('[data-multi-timeframe-charts] [data-chart-summary]').count(), 0, 'Charts must not reserve a separate title or status row.')
      assert.equal(await page.locator('[data-shared-chart-status]').count(), 0, 'The chart toolbar does not duplicate status messages.')
      const footer = page.locator('[data-market-status-row]')
      assert.equal(await footer.evaluate(node => getComputedStyle(node).borderTopWidth), '1px', 'The status area is separated from the contract list.')
      assert.equal(await footer.getByText(/^\d+ contracts$/).count(), 0, 'The status area does not show a contract count.')
      assert.equal(await footer.locator('[data-status-trigger], details, summary').count(), 0, 'Status information is shown without an expand action.')
      assert.equal(await footer.locator('[data-status-details]').isVisible(), true, 'The shared status information is visible by default.')
      const statuses = await page.locator('[data-chart-shared-status-item]').evaluateAll(nodes => nodes.map(node => ({ timeframe: node.dataset.chartSharedStatusItem, shared: !!node.closest('[data-market-status-row]') })))
      assert.ok(statuses.every(status => status.shared && frames.includes(status.timeframe)), 'Chart statuses belong in the footer and identify their timeframe.')
      assert.deepEqual(await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => svg.getAttribute('aria-label')?.match(/(?:1h|15m|5m)/i)?.[0]?.toLowerCase())), ['1h', '15m', '5m'])
      assert.equal(await page.locator('[data-chart-indicator="rsi6"]').count(), 0)
      assert.equal(await page.locator('[data-chart-indicator="ema"], [data-chart-legend="EMA(200)"]').count(), 0)
      for (const field of ['vwap', 'bollUpper', 'bollMiddle', 'bollLower']) assert.equal(await page.locator(`[data-chart-indicator="${field}"]`).count(), 3)
      const positions = await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => ({ top: svg.getBoundingClientRect().top, height: svg.getBoundingClientRect().height })))
      assert.ok(positions.every(position => position.height > 60))
      assert.ok(positions[0].top < positions[1].top && positions[1].top < positions[2].top)
      const geometry = await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => ({
        top: chart.getBoundingClientRect().top,
        plotTop: chart.querySelector('[data-chart-plot]').getBoundingClientRect().top,
      })))
      assert.ok(geometry.every(({ top, plotTop }) => Math.abs(top - plotTop) < 1), 'Each plot starts at the top of its chart without a reserved header.')
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
    const inspectedChart = page.locator('[data-chart-inst]').nth(1)
    const plotBeforeInspection = await inspectedChart.locator('[data-chart-plot]').boundingBox()
    await page.mouse.move(plotBeforeInspection.x + plotBeforeInspection.width / 2, plotBeforeInspection.y + plotBeforeInspection.height / 2)
    await page.mouse.down()
    await inspectedChart.locator('[data-chart-inspection-readout]').waitFor({ state: 'visible' })
    assert.match(await inspectedChart.locator('[data-chart-inspection-readout]').textContent(), /Open.*High.*Low.*Close/)
    assert.deepEqual(await inspectedChart.locator('[data-chart-plot]').boundingBox(), plotBeforeInspection, 'Inspection must not reserve a row or resize the plot.')
    await page.mouse.up()
    await inspectedChart.locator('[data-chart-inspection-readout]').waitFor({ state: 'hidden' })
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
    // The shared latest boundary must leave the entire forming candle inside
    // each plot, including at the beginning of an hour. Inspect actual SVG
    // paths as well as the viewport so a clipped path cannot pass unnoticed.
    const assertFormingCandlesFit = async () => {
      await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-inst]')].length === 3
        && [...document.querySelectorAll('[data-chart-inst]')].every(chart => {
          const svg = chart.querySelector('svg[data-rendered-inst]'), bar = chart.__chartSnapshot?.liveBar
          if (!svg || !bar) return false
          const intervals = { '1H': 3_600_000, '15m': 900_000, '5m': 300_000 }
          const interval = intervals[svg.dataset.renderedTimeframe]
          const right = Number(svg.dataset.chartPlotRight), width = Number(svg.dataset.chartBarWidth)
          const domainEnd = Number(svg.dataset.chartDomainEnd), spacing = Number(chart.dataset.chartBarSpacing)
          const offset = Number(svg.querySelector('[data-chart-wheel-content]')?.dataset.chartWheelOffset ?? 0)
          const center = right - width / 2 + (bar.hour - domainEnd) / interval * spacing + offset
          return Number.isFinite(center) && center + width / 2 <= right + .01
        }), null, { timeout: 15_000 })
      const candles = await page.locator('[data-chart-inst]').evaluateAll(charts => charts.map(chart => {
        const svg = chart.querySelector('svg[data-rendered-inst]'), bar = chart.__chartSnapshot.liveBar
        const intervals = { '1H': 3_600_000, '15m': 900_000, '5m': 300_000 }
        const right = Number(svg.dataset.chartPlotRight), width = Number(svg.dataset.chartBarWidth)
        const offset = Number(svg.querySelector('[data-chart-wheel-content]')?.dataset.chartWheelOffset ?? 0)
        const center = right - width / 2 + (bar.hour - Number(svg.dataset.chartDomainEnd)) / intervals[svg.dataset.renderedTimeframe] * Number(chart.dataset.chartBarSpacing) + offset
        const group = svg.querySelector('[data-chart-candle-direction]')?.parentElement
        const paths = [...group.querySelectorAll('path')].map(path => path.getAttribute('d') ?? '')
        const number = '[-+]?(?:\\d*\\.)?\\d+(?:e[-+]?\\d+)?'
        const bodies = paths.slice(3).flatMap(d => [...d.matchAll(new RegExp(`M(${number}) (${number})h(${number})v(${number})h(${number})Z`, 'gi'))].map(match => ({ x: Number(match[1]) + offset, width: Number(match[3]) })))
        const wicks = paths.slice(0, 3).flatMap(d => [...d.matchAll(new RegExp(`M(${number}) (${number})V(${number})`, 'gi'))].map(match => Number(match[1]) + offset))
        return { frame: svg.dataset.renderedTimeframe, right, width, center, bodies, wicks }
      }))
      for (const candle of candles) {
        assert.ok(candle.bodies.some(body => Math.abs(body.x + body.width / 2 - candle.center) < .01 && body.x + body.width <= candle.right + .01), `${candle.frame} forming candle body must be fully inside the plot.`)
        assert.ok(candle.wicks.some(x => Math.abs(x - candle.center) < .01 && x <= candle.right), `${candle.frame} forming candle wick must be inside the plot.`)
      }
    }
    // The axis must be shared across frames, sized to what is actually drawn,
    // and never rely on SVG textLength to squeeze labels into a narrow gutter.
    const assertAxisLayout = async (requireCompact = false) => {
      await page.waitForFunction(() => {
        const svgs = [...document.querySelectorAll('svg[data-rendered-inst]')]
        if (svgs.length !== 3) return false
        const edges = svgs.map(svg => Number(svg.dataset.chartPlotRight))
        return edges.every(edge => Number.isFinite(edge) && Math.abs(edge - edges[0]) < .01)
      }, null, { timeout: 10_000 })
      const axes = await page.locator('svg[data-rendered-inst]').evaluateAll(svgs => svgs.map(svg => {
        const width = svg.viewBox.baseVal.width
        const labels = [...svg.querySelectorAll('[data-chart-price-tick] text, [data-chart-price-label-value], [data-chart-countdown]')]
        return {
          gutter: width - Number(svg.dataset.chartPlotRight) - 4,
          labels: labels.map(label => ({ text: label.textContent, x: Number(label.getAttribute('x')),
            naturalWidth: label.getComputedTextLength(), compressed: label.hasAttribute('textLength') })), width,
        }
      }))
      for (const axis of axes) for (const label of axis.labels) {
        assert.equal(label.compressed, false, `Axis label ${label.text} must not be compressed.`)
        assert.ok(label.x + label.naturalWidth <= axis.width + .5, `Axis label ${label.text} must fit in its SVG.`)
      }
      if (requireCompact) assert.ok(axes.every(axis => axis.gutter < 96), 'Short labels must not reserve the old 96px fixed gutter.')
    }
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
    await assertFormingCandlesFit()
    await assertAxisLayout(true)
    await page.locator('[data-chart-plot]').nth(1).evaluate(plot => plot.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true })))
    const panned = await waitForSynchronizedViewports(initial, 'pan')
    await assertAxisLayout()
    // Zooming any one chart changes candle width in all three.
    await page.locator('[data-chart-plot]').nth(2).evaluate(plot => {
      const rect = plot.getBoundingClientRect()
      plot.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -19, clientX: rect.left + rect.width * .4, bubbles: true, cancelable: true }))
    })
    await waitForSynchronizedViewports(panned, 'zoom')
    await assertAxisLayout()
    // Return to the latest time and verify all three resume native updates.
    await page.locator('[data-chart-plot]').first().evaluate(plot => plot.dispatchEvent(new WheelEvent('wheel', { deltaX: 100_000, bubbles: true, cancelable: true })))
    await waitForSynchronizedViewports(null, null)
    await live(btc, 141.25, 35)
    await assertFormingCandlesFit()
    await page.evaluate(() => { location.hash = '#/settings/workspace' })
    await page.getByRole('main', { name: 'Settings', exact: true }).getByRole('link', { name: 'Settings', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-multi-timeframe-charts] svg[data-rendered-inst]').length === 3)
    await page.locator(`[aria-label="View ${eth} chart"]`).click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-inst]')].every(chart => chart.__chartSnapshot?.instId === 'ETH-USDT-SWAP'))
    await ready(eth)
    await waitForSynchronizedViewports(null, null)
    await assertAxisLayout()
    console.log('multiframe: ETH ready')
    await live(eth, 142.75, 40)
    await assertFormingCandlesFit()
    // Observe the real capture while intercepting the final clipboard write so
    // this background test never alters the user's clipboard.
    await page.addInitScript(() => {
      const define = Object.defineProperty
      Object.defineProperty = function (target, key, descriptor) {
        if (target === window && key === 'radarDesktop') {
          Object.defineProperty = define
          const original = descriptor.value
          descriptor.value = Object.freeze({ ...original, request: (...args) => {
            if (args[0]?.captureChart) {
              window.__captureBounds = args[0].captureChart
              const button = document.querySelector('[data-chart-toolbar] button')
              const buttonRect = button.getBoundingClientRect()
              window.__captureButton = { x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height, opacity: getComputedStyle(button).opacity }
              window.__captureTitle = document.querySelector('[data-shared-chart-title]')?.textContent
            }
            if (args[0]?.copyImage) { window.__copiedImage = args[0].copyImage; return Promise.resolve({ ok: true }) }
            return original.request(...args)
          } })
        }
        return define(target, key, descriptor)
      }
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator(`[aria-label="View ${eth} chart"]`).click()
    await ready(eth)
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-inst]')].length === 3
      && [...document.querySelectorAll('[data-chart-inst]')].every(chart => chart.dataset.chartLoading === 'false' && Number(chart.dataset.chartRenderedBars) > 0))
    const assertCapture = async () => {
      const bounds = await page.locator('[data-chart-capture]').boundingBox()
      await page.evaluate(() => { window.__copiedImage = null })
      await page.getByRole('button', { name: /^(Copy chart|Copied)$/ }).click()
      await page.waitForFunction(() => window.__copiedImage !== null || document.querySelector('[data-chart-panel] [role="alert"]'))
      const error = await page.locator('[data-chart-panel] [role="alert"]').allTextContents()
      assert.deepEqual(error, [], `Capture must succeed: ${error.join(' ')}`)
      const captured = await page.evaluate(() => ({ bounds: window.__captureBounds, image: window.__copiedImage, button: window.__captureButton, title: window.__captureTitle }))
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(captured.bounds[key] - bounds[key]) < 1, `Capture ${key} must cover the entire multi-timeframe capture container.`)
      assert.match(captured.image, /^data:image\/png;base64,/)
      assert.ok(Number(captured.button.opacity) > 0, 'Copy progress remains visible during capture.')
      const masked = await page.evaluate(async ({ bounds, button, image }) => {
      const bitmap = new Image()
      bitmap.src = image
      await bitmap.decode()
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.naturalWidth; canvas.height = bitmap.naturalHeight
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0)
      const left = Math.floor(bounds.x), top = Math.floor(bounds.y)
      const sx = canvas.width / (Math.ceil(bounds.x + bounds.width) - left), sy = canvas.height / (Math.ceil(bounds.y + bounds.height) - top)
      const x = Math.ceil((button.x - left) * sx), y = Math.ceil((button.y - top) * sy)
      const right = Math.floor((button.x + button.width - left) * sx), bottom = Math.floor((button.y + button.height - top) * sy)
      const background = context.getImageData(canvas.width - Math.ceil(3 * sx), Math.round((button.y + button.height / 2 - top) * sy), 1, 1).data
      const pixels = context.getImageData(x, y, right - x, bottom - y).data
      return { blank: pixels.every((value, index) => value === background[index % 4]), background: [...background] }
      }, captured)
      assert.ok(masked.blank, 'The entire button, including its border, must match the toolbar background in the copied image.')
      assert.equal(captured.title, 'ETH-USDT', 'The copied image must identify its contract.')
      // Compare the restored pixels against a reference capture of the same
      // chart with the panel hidden in the test only. The live copy path keeps
      // the panel visible and usable throughout the asynchronous request.
      const reference = await page.evaluate(async bounds => {
        const overlay = document.querySelector('[data-market-overlay]')
        const rect = overlay.getBoundingClientRect()
        overlay.style.visibility = 'hidden'
        try {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const image = await window.radarDesktop.request({ captureChart: { ...bounds, output: 'png' } })
          return { image: image.imageDataURL, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, chartTop: document.querySelector('svg[data-rendered-inst]').getBoundingClientRect().top }
        } finally { overlay.style.removeProperty('visibility') }
      }, captured.bounds)
      const comparison = await page.evaluate(async ({ captured, reference }) => {
        const load = async src => { const image = new Image(); image.src = src; await image.decode(); return image }
        const [actual, expected] = await Promise.all([load(captured.image), load(reference.image)])
        const canvas = document.createElement('canvas'); canvas.width = actual.naturalWidth; canvas.height = actual.naturalHeight
        const ctx = canvas.getContext('2d'); ctx.drawImage(actual, 0, 0); const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(expected, 0, 0); const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        const sx = canvas.width / (Math.ceil(captured.bounds.x + captured.bounds.width) - Math.floor(captured.bounds.x))
        const sy = canvas.height / (Math.ceil(captured.bounds.y + captured.bounds.height) - Math.floor(captured.bounds.y))
        const x0 = Math.max(0, Math.ceil((reference.rect.x - 16 - captured.bounds.x) * sx)), x1 = Math.min(canvas.width, Math.floor((reference.rect.x + reference.rect.width + 16 - captured.bounds.x) * sx))
        const y0 = Math.max(0, Math.ceil((Math.max(reference.chartTop, reference.rect.y - 16) - captured.bounds.y) * sy)), y1 = Math.min(canvas.height, Math.floor((reference.rect.y + reference.rect.height + 16 - captured.bounds.y) * sy))
        let different = 0, total = 0
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = (y * canvas.width + x) * 4
          if (Math.max(...[0, 1, 2].map(channel => Math.abs(a[i + channel] - b[i + channel]))) > 30) different++
          total++
        }
        return { different, total }
      }, { captured, reference })
      assert.ok(comparison.total > 0 && comparison.different / comparison.total < .03, `Restored chart pixels must match the unobstructed chart: ${JSON.stringify(comparison)}`)
      return masked.background
    }
    await page.emulateMedia({ colorScheme: 'dark' })
    const darkBackground = await assertCapture()
    await page.getByRole('button', { name: 'Hide contract list' }).click()
    await assertCapture()
    await page.getByRole('button', { name: /^Show contract list/ }).click()
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 1373, height: 917 })
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chart-inst]')].every(chart => chart.dataset.chartLoading === 'false'))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const lightBackground = await assertCapture()
    assert.notDeepEqual(lightBackground, darkBackground, 'Capture must be checked against both theme backgrounds.')
    // A sudden large move produces a much longer real-time percentage. All
    // three axes must grow together rather than clipping or squeezing it.
    const normalGutter = await page.locator('svg[data-rendered-inst]').first().evaluate(svg => svg.viewBox.baseVal.width - Number(svg.dataset.chartPlotRight) - 4)
    await live(eth, 123_456_789, 50)
    await page.waitForFunction(previous => [...document.querySelectorAll('svg[data-rendered-inst]')].every(svg =>
      svg.viewBox.baseVal.width - Number(svg.dataset.chartPlotRight) - 4 > previous), normalGutter)
    await assertAxisLayout()
    assert.equal(await page.getByRole('button', { name: 'Indicators', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Analyze Long', exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(exchange.businessSubscriptions(), [`candle5m:${btc}`, `candle5m:${eth}`].sort())
  } finally {
    if (electron) await electron.close()
    await exchange.close()
    await rm(directory, { recursive: true, force: true })
  }
})
