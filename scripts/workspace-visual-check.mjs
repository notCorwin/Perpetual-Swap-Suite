// Renderer-only visual acceptance, using the same real Electron/IPC-boundary
// approach as tests/e2e/workspace.e2e.mjs. Build the renderer before running:
// npm exec --yes --package=node@24.22.0 -- node scripts/workspace-visual-check.mjs
// PNGs and measured colors are written to .build/ui-review/visual by default.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import { assertIndicatorLegends, assertWorkspaceLayout } from './chart-acceptance.mjs'

const root = new URL('..', import.meta.url).pathname
const output = resolve(process.env.PERPETUAL_SWAP_UI_VISUAL_OUTPUT ?? '.build/ui-review/visual')
const userData = await mkdtemp(join(tmpdir(), 'perp-visual-'))
const report = { fixture: 'Offline desktop-boundary fixture; production renderer and preload', contrastMethod: 'WCAG relative luminance after browser sRGB conversion and compositing each element over its painted ancestor backgrounds. Plot intersections and antialiasing require screenshot review; outlined mandated colors are reported separately.', baselineWidth: 1600, screenshots: [], measurements: [], failures: [] }
await mkdir(output, { recursive: true })
let electron
try {
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await electron.evaluate(({ ipcMain }) => {
    const preferences = { chartTimeframe: '15m', rankingLookback: 15, historyDays: 30, liquidity: {
      spread: { enabled: true, maxPercent: .05 }, depth: { enabled: true, minUSDT: 100_000 },
      slippage: { enabled: true, maxPercent: .1, notionalUSDT: 100_000 }, volume24h: { enabled: true, minUSDT: 30_000_000 },
      openInterest: { enabled: true, minUSDT: 5_000_000 }, volumeStability: { enabled: false, maxRatio: 2 },
    } }
    const rows = [['BETA', -3], ['ZETA', 3], ['ALPHA', 1], ['NULL', null]].map(([symbol, rankingChange]) => ({
      instId: `${symbol}-USDT-SWAP`, price: 100, lastPrice: 100, rankingChange, rankingAsOf: 1_800_000_000_000, turnover24hUSDT: 50_000_000,
    }))
    const prepared = ({ instId, timeframe }) => {
      const intervalMS = timeframe === '1H' ? 3_600_000 : timeframe === '15m' ? 900_000 : 300_000
      const endHour = Math.floor(Date.UTC(2026, 9, 18) / intervalMS) * intervalMS
      const bars = Array.from({ length: 96 }, (_, index) => {
        const close = 100 + index * .01
        const averageTrueRange = .4 + .06 * Math.sin(index / 8) + .025 * Math.cos(index / 17)
        const bandHalfWidth = .5 + .18 * Math.cos(index / 13) + .04 * Math.sin(index / 5)
        return { hour: endHour - (95 - index) * intervalMS, open: close + (index % 2 ? -.05 : .05), high: close + .2, low: close - .2, close,
          confirmed: true, statisticsSources: 3, statisticsObserved: true, indicatorsObserved: true,
          ema: close, vwap: close - .02, bollUpper: close + bandHalfWidth, bollMiddle: close, bollLower: close - bandHalfWidth,
          roc: .5, maroc: .25, rsi6: 50, rsi12: 55, rsi24: 60,
          atrPercent: averageTrueRange / close * 100, bbw: bandHalfWidth * 2 / close * 100, oi: 1_000_000 + index, buy: 12_000, sell: 10_000 }
      })
      return { instId, timeframe, intervalMS, endHour, latestEnd: endHour, oldestHour: bars[0].hour, historyExhausted: true,
        generation: 1, revision: 1, bars, oiState: 'ready', takerState: 'ready', indicatorState: 'ready', error: '' }
    }
    ipcMain.removeHandler('radar:request')
    ipcMain.handle('radar:request', async (_event, value) => {
      if (value.preferences) return preferences
      if (value.snapshot) return { rows, turnoverOrder: [...rows].sort((a, b) => a.instId.localeCompare(b.instId, 'en')).map(row => row.instId), revision: 1, serviceSession: 'visual-fixture',
        realtimeState: 'Connected', updatedAt: 1_800_000_000_000, catalogSource: 'live', error: '', loading: false }
      if (value.chartUniverse) return { frames: rows.flatMap(({ instId }) => ['5m', '15m', '1H'].map(timeframe => prepared({ instId, timeframe }))) }
      if (value.chartFocus) return { ok: true }
      if (value.chartLocal) return prepared(value.chartLocal)
      if (value.chartHistory) return prepared(value.chartHistory)
      if (value.chartWindow) return prepared(value.chartWindow)
      if (value.analysisSettings) return { model: '', hasAPIKey: false }
      if (value.dataAudit) return { phase: 'idle', progress: { completed: 0, total: 0 }, issues: [], error: '' }
      throw new Error(`Unsupported visual fixture operation: ${Object.keys(value).join(', ')}`)
    })
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('svg[data-rendered-inst="BETA-USDT-SWAP"]').waitFor({ state: 'visible' })
  const client = await page.context().newCDPSession(page)
  const stablePaint = async () => {
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const screenshot = async (name, width, height, dpr) => {
    // Playwright's Electron context retains its original DPR; page.screenshot
    // can reset an overridden DPR during capture. Capture through the same CDP
    // session that emulates metrics, then verify the actual PNG dimensions.
    await stablePaint()
    const path = join(output, `${name}.png`)
    const captured = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } })
    const bytes = Buffer.from(captured.data, 'base64')
    await writeFile(path, bytes)
    const pixels = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    report.screenshots.push({ name, path, css: { width, height }, dpr, pixels })
    assert.equal(pixels.width, width * dpr, `Unexpected screenshot width: ${name}`)
    assert.equal(pixels.height, height * dpr, `Unexpected screenshot height: ${name}`)
  }
  const measure = () => page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    const rgba = color => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value)
    }
    const over = (foreground, background) => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3])
      return [...foreground.slice(0, 3).map((channel, index) => (channel * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha), alpha]
    }
    const luminance = color => color.slice(0, 3).reduce((sum, channel, index) => {
      const value = channel / 255
      return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]
    }, 0)
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
    const background = element => {
      const chain = []
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) chain.unshift(ancestor)
      return chain.reduce((result, ancestor) => over(rgba(getComputedStyle(ancestor).backgroundColor), result), [255, 255, 255, 1])
    }
    const visible = element => {
      const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
      const hasGeometry = element instanceof SVGGeometryElement ? bounds.width + bounds.height > 1 : bounds.width > 1 && bounds.height > 1
      return style.visibility !== 'hidden' && style.display !== 'none' && hasGeometry && bounds.x < innerWidth && bounds.y < innerHeight && bounds.right >= 0 && bounds.bottom >= 0 && !element.closest('.sr-only,[inert]')
    }
    const selector = element => element.dataset.chartIndicator ? `[data-chart-indicator="${element.dataset.chartIndicator}"]`
      : element.dataset.chartLegend ? `[data-chart-legend="${element.dataset.chartLegend}"]`
        : element.dataset.chartCandleDirection ? `[data-chart-candle-direction="${element.dataset.chartCandleDirection}"]`
          : element.hasAttribute('data-chart-live-price') ? '[data-chart-live-price]'
            : element.hasAttribute('data-chart-taker-buy-samples') ? '[data-chart-taker-buy-samples]'
              : element.hasAttribute('data-chart-taker-sell-samples') ? '[data-chart-taker-sell-samples]'
          : element.getAttribute('aria-label') || element.id || element.dataset.slot || element.tagName.toLowerCase()
    const scope = document.querySelector('[role="dialog"]') ?? document.body
    const texts = [...scope.querySelectorAll('*')].filter(element => visible(element) && !element.closest('[aria-hidden="true"]') && ([...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) || element.matches('input,textarea'))).map(element => {
      const style = getComputedStyle(element), bg = background(element), svg = element instanceof SVGElement
      const color = rgba(svg ? style.fill : style.color)
      color[3] *= Number(style.opacity) * (svg ? Number(style.fillOpacity) : 1)
      const actual = over(color, bg)
      const disabled = Boolean(element.closest(':disabled,[aria-disabled="true"]'))
      return { element: selector(element), text: (element.matches('input,textarea') ? element.value : [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim()).slice(0, 100), color: actual.slice(0, 3), background: bg.slice(0, 3), ratio: contrast(actual, bg), threshold: disabled ? null : 4.5, exemption: disabled ? 'Disabled control' : undefined, fontSize: style.fontSize, fontVariantNumeric: style.fontVariantNumeric }
    })
    const graphics = [...scope.querySelectorAll('[data-chart-indicator], [data-chart-legend], [data-chart-candle-direction], [data-chart-taker-buy-samples], [data-chart-taker-sell-samples], [data-chart-live-price], .text-positive, .text-negative')].filter(visible).map(element => {
      const style = getComputedStyle(element), bg = background(element)
      const filledPath = element instanceof SVGPathElement && style.fill !== 'none' && element.dataset.chartCandleFill !== 'hollow'
      const property = filledPath ? 'fill' : style.stroke && style.stroke !== 'none' ? 'stroke' : element instanceof SVGElement ? 'fill' : 'color'
      const paintedColor = (target, paintProperty) => {
        const targetStyle = getComputedStyle(target), color = rgba(targetStyle[paintProperty])
        color[3] *= Number(targetStyle.opacity) * (paintProperty === 'fill' ? Number(targetStyle.fillOpacity) : paintProperty === 'stroke' ? Number(targetStyle.strokeOpacity) : 1)
        return over(color, bg)
      }
      const actual = paintedColor(element, property), paintRatio = contrast(actual, bg), boundaries = []
      const addBoundary = (target, source) => {
        const boundaryStyle = getComputedStyle(target), color = paintedColor(target, 'stroke')
        boundaries.push({ source, element: target.hasAttribute('data-chart-live-price-outline') ? '[data-chart-live-price-outline]'
          : target.hasAttribute('data-chart-legend-outline') ? `[data-chart-legend-outline="${target.dataset.chartLegendOutline}"]` : selector(target),
        geometryMatches: true, color: color.slice(0, 3), strokeWidth: boundaryStyle.strokeWidth, strokeDasharray: boundaryStyle.strokeDasharray,
        contrastAgainstSurface: contrast(color, bg), contrastAgainstPaint: contrast(color, actual) })
      }
      if (filledPath && style.stroke !== 'none' && Number.parseFloat(style.strokeWidth) > 0) addBoundary(element, 'same-element stroke')
      const previous = element.previousElementSibling
      if (previous instanceof SVGGeometryElement && previous.tagName === element.tagName) {
        const previousStyle = getComputedStyle(previous)
        const geometry = element instanceof SVGLineElement ? ['x1', 'y1', 'x2', 'y2'] : element instanceof SVGPathElement ? ['d'] : []
        const width = Number.parseFloat(style.strokeWidth), previousWidth = Number.parseFloat(previousStyle.strokeWidth)
        const dashes = style.strokeDasharray.split(/[ ,]+/).map(Number.parseFloat)
        // Each candle is a separate M subpath, where the dash pattern restarts.
        const lengths = element instanceof SVGPathElement ? (element.getAttribute('d')?.match(/[Mm][^Mm]*/g) ?? []).map(d => {
          const path = element.cloneNode(false)
          path.setAttribute('d', d)
          return path.getTotalLength()
        }) : [element.getTotalLength()]
        const exposedSegments = previousWidth === width && previousStyle.strokeDasharray === 'none'
          && Number.parseFloat(style.strokeDashoffset) === 0
          && dashes.length === 2 && dashes.every(Number.isFinite) && dashes[0] > 0 && dashes[1] > width
          && lengths.length > 0 && lengths.every(length => length > dashes[0] + width)
        // Equal-width paint only qualifies when real gaps expose the stroke below.
        if (geometry.length && geometry.every(attribute => previous.getAttribute(attribute) === element.getAttribute(attribute))
          && previousStyle.stroke !== 'none' && exposedSegments) addBoundary(previous, 'matching stroke visible through dashed paint')
      }
      const boundaryContrast = boundaries.length ? Math.max(...boundaries.map(boundary => boundary.contrastAgainstSurface)) : null
      const effectiveContrast = Math.max(paintRatio, boundaryContrast ?? 0)
      const decorative = element.matches('.text-positive,.text-negative') && element.getAttribute('aria-hidden') === 'true'
      return { element: selector(element), property, rawPaintColor: rgba(style[property]).slice(0, 3), color: actual.slice(0, 3), background: bg.slice(0, 3),
        ratio: effectiveContrast, effectiveContrast, paintRatio, boundaryContrast, boundaries, threshold: decorative ? null : 3,
        exemption: decorative ? 'Decorative arrow; signed numeric value conveys direction' : undefined, strokeDasharray: style.strokeDasharray, candleFill: element.dataset.chartCandleFill }
    })
    const renderedChart = document.querySelector('svg[data-rendered-inst]')
    const chartLineDash = field => {
      const line = renderedChart?.querySelector(`[data-chart-indicator="${field}"]`)
      return line ? getComputedStyle(line).strokeDasharray : null
    }
    const rootStyle = getComputedStyle(document.documentElement)
    const semantics = { positive: rgba(rootStyle.getPropertyValue('--positive')).slice(0, 3), negative: rgba(rootStyle.getPropertyValue('--negative')).slice(0, 3),
      positiveLabel: rgba(rootStyle.getPropertyValue('--chart-positive-label')).slice(0, 3), negativeLabel: rgba(rootStyle.getPropertyValue('--chart-negative-label')).slice(0, 3),
      takerLegends: [...renderedChart?.querySelectorAll('[data-chart-panel-header="taker"] [data-chart-legend]') ?? []].map(swatch => ({ label: swatch.dataset.chartLegend,
        labelColor: rgba(getComputedStyle(swatch.parentElement.querySelector('text')).fill).slice(0, 3), swatchColor: rgba(getComputedStyle(swatch).stroke).slice(0, 3) })),
      upFill: renderedChart?.querySelector('[data-chart-candle-direction="up"]')?.dataset.chartCandleFill,
      downFill: renderedChart?.querySelector('[data-chart-candle-direction="down"]')?.dataset.chartCandleFill,
      emaDash: chartLineDash('ema'), vwapDash: chartLineDash('vwap') }
    return { texts, graphics, semantics }
  })
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    for (const dpr of [1, 2]) for (const width of [1200, 1600, 2000]) {
      await page.setViewportSize({ width, height: 1000 })
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: dpr, mobile: false })
      await page.waitForFunction(({ width, dpr }) => innerWidth === width && devicePixelRatio === dpr && Number(document.querySelector('[data-layout="market-workspace"]').dataset.uiScale) === width / 1600, { width, dpr })
      await stablePaint()
      await assertWorkspaceLayout(page)
      await screenshot(`workspace-${theme}-${width}-dpr${dpr}`, width, 1000, dpr)
      await client.send('Emulation.setEmulatedVisionDeficiency', { type: 'achromatopsia' })
      await screenshot(`workspace-${theme}-gray-${width}-dpr${dpr}`, width, 1000, dpr)
      await client.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' })
      if (width === 1600 && dpr === 1) {
        const indicators = await assertIndicatorLegends(page, { requireFittedVolatility: true })
        const measured = await measure()
        measured.semantics.volatilityFits = indicators.volatilityFits
        assert.deepEqual(measured.semantics.positive, theme === 'light' ? [142, 188, 57] : [202, 253, 92])
        assert.deepEqual(measured.semantics.negative, [232, 85, 168])
        assert.equal(measured.semantics.upFill, 'hollow')
        assert.equal(measured.semantics.downFill, 'solid')
        assert.notEqual(measured.semantics.emaDash, measured.semantics.vwapDash)
        assert.equal(measured.semantics.takerLegends.length, 2)
        for (const [index, legend] of measured.semantics.takerLegends.entries()) {
          assert.deepEqual(legend.labelColor, index === 0 ? measured.semantics.positiveLabel : measured.semantics.negativeLabel, 'Taker titles must use the accessible financial label tokens.')
          assert.deepEqual(legend.swatchColor, index === 0 ? measured.semantics.positive : measured.semantics.negative, 'Taker swatches must preserve the mandated market colors.')
        }
        report.measurements.push({ theme, surface: 'workspace', ...measured })
        await page.getByRole('link', { name: 'Settings', exact: true }).click()
        const settings = page.getByRole('main', { name: 'Settings', exact: true })
        await settings.waitFor({ state: 'visible' })
        await screenshot(`settings-${theme}-top`, width, 1000, dpr)
        report.measurements.push({ theme, surface: 'settings-top', ...await measure() })
        await settings.getByRole('link', { name: 'Market data', exact: true }).click()
        await screenshot(`settings-${theme}-bottom`, width, 1000, dpr)
        report.measurements.push({ theme, surface: 'settings-bottom', ...await measure() })
        await settings.getByRole('link', { name: 'Back to markets', exact: true }).click()
        await settings.waitFor({ state: 'hidden' })
      }
    }
  }
  for (const measurement of report.measurements) for (const kind of ['texts', 'graphics']) {
    for (const item of measurement[kind]) if (item.ratio < item.threshold) report.failures.push({ theme: measurement.theme, surface: measurement.surface, kind, ...item })
  }
  await client.detach()
  report.summary = { screenshots: report.screenshots.length, measurements: report.measurements.length, textFailures: report.failures.filter(item => item.kind === 'texts').length, graphicFailures: report.failures.filter(item => item.kind === 'graphics').length }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output, ...report.summary }, null, 2))
  // Low financial paint contrast remains visible in the report; a matching
  // outline is measured explicitly before deciding whether a graphic fails.
  if (report.failures.length) process.exitCode = 1
} finally {
  await electron?.close()
  await rm(userData, { recursive: true, force: true })
}
