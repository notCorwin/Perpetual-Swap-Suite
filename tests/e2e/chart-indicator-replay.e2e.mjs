import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron } from 'playwright'

test('indicator replay preserves visible paths while current prices update and terminal nulls clear them', { timeout: 60_000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-indicator-replay-'))
  let electron
  try {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ chartDisplayMode: 'multi' }))
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.evaluate(() => window.radarDesktop.request({ e2e: { action: 'seedInstrumentNavigationBenchmark' } }))
    await page.waitForFunction(() => document.querySelector('svg[data-rendered-timeframe="15m"]')?.closest('[data-chart-inst]')?.__chartSnapshot?.indicatorState === 'ready')
    await electron.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents, send = contents.send
      contents.send = function(channel, ...args) {
        if (channel !== 'radar:chart-prepared') return send.call(this, channel, ...args)
      }
    })
    const replay = await page.evaluate(async () => {
      const chart = document.querySelector('svg[data-rendered-timeframe="15m"]')?.closest('[data-chart-inst]'), frame = chart.__chartSnapshot
      const fields = ['ema', 'bollUpper', 'bollMiddle', 'bollLower', 'roc', 'maroc', 'rsi6', 'rsi12', 'rsi24', 'atrPercent', 'bbw']
      const svg = chart.querySelector('svg[data-rendered-inst]')
      const band = svg.querySelector('[data-chart-boll-band]')?.getAttribute('d')
      const observations = []
      const send = async detail => {
        window.dispatchEvent(new CustomEvent('radar-chart-prepared', { detail }))
        await new Promise(resolve => requestAnimationFrame(resolve))
        await new Promise(resolve => requestAnimationFrame(resolve))
        const source = chart.__chartSnapshot, rendered = chart.__chartRenderedBars
        const status = document.querySelector('[data-market-status] [data-chart-shared-status-item="15m"]')
        observations.push({ state: source.indicatorState, stale: chart.dataset.chartIndicatorStale,
          continuous: !!svg.querySelector('[data-chart-boll-band]')?.getAttribute('d'),
          sourceNull: source.bars.every(bar => bar.bollUpper === null), renderedBand: rendered.find(bar => bar.hour === source.bars.at(-1).hour)?.bollUpper,
          sourceClose: source.bars.at(-1).close, renderedClose: rendered.find(bar => bar.hour === source.bars.at(-1).hour)?.close,
          previousNotice: status?.textContent.includes('Showing previous indicators') ?? false,
          sameSurface: chart.querySelector('svg[data-rendered-inst]') === svg })
      }
      const price = frame.bars.at(-1).close * 1.001
      const raw = { ...frame, generation: frame.generation + 100, revision: 1, latestEnd: frame.endHour, liveBar: undefined,
        indicatorState: 'loading', indicatorStatus: undefined,
        bars: frame.bars.map((bar, index) => ({ ...bar, ...Object.fromEntries(fields.map(field => [field, null])), indicatorsObserved: false,
          ...(index === frame.bars.length - 1 ? { close: price, high: Math.max(price, bar.high) } : {}) })) }
      await send(raw)
      await send({ ...raw, revision: 2, bars: raw.bars.map((bar, index) => index < 20 ? { ...bar, ...Object.fromEntries(fields.map(field => [field, frame.bars[index][field]])), indicatorsObserved: true } : bar) })
      await send({ ...raw, revision: 3, indicatorState: 'unavailable', bars: raw.bars.map(bar => ({ ...bar, indicatorsObserved: true })) })
      return { observations, band, price, oldBand: frame.bars.at(-1).bollUpper }
    })
    assert.ok(replay.band, 'The BOLL background must exist before replay.')
    for (const state of replay.observations.slice(0, 2)) {
      assert.equal(state.state, 'loading')
      assert.equal(state.stale, 'true')
      assert.equal(state.continuous, true, 'All previously visible indicator paths remain drawn during replay.')
      assert.equal(state.renderedBand, replay.oldBand)
      assert.equal(state.sourceClose, replay.price)
      assert.equal(state.renderedClose, replay.price, 'New candle prices must be displayed during indicator replay.')
      assert.equal(state.previousNotice, true, 'A stale indicator warning remains visible during replay.')
      assert.equal(state.sameSurface, true)
    }
    assert.equal(replay.observations[0].sourceNull, true, 'Retained visual indicators must not enter the authoritative source.')
    assert.equal(replay.observations[2].state, 'unavailable')
    assert.equal(replay.observations[2].stale, 'false')
    assert.equal(replay.observations[2].renderedBand, null, 'Terminal nulls must clear the retained curves.')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false)
    assert.deepEqual(pageErrors, [])
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
