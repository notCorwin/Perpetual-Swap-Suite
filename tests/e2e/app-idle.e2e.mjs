import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wheelBurst } from '../../scripts/chart-acceptance.mjs'
import { assertReadyFrame, awaitReady, delay, expectedClose, hash, installReadyRecorder, launchIdleApp,
  presentationState, probe, removeReadyRecorder, seedAndPrepare, selectChart, setActive, waitLoad } from '../../scripts/app-idle-helpers.mjs'

// This exercises the production app activation handler through its test-only
// entry point. It does not change native focus, visibility, or activation.
test('simulated app idle retains historical UI and background work, then resumes the latest source', { timeout: 540_000 }, async t => {
  const app = await launchIdleApp()
  const { electron, page } = app
  let seeded = false, stopped = false, recorder = false
  try {
    const initial = await presentationState(electron)
    await electron.evaluate(({ app, BrowserWindow }) => app.emit('browser-window-blur', {}, BrowserWindow.getAllWindows()[0]))
    await delay(250)
    assert.deepEqual(await presentationState(electron), initial, 'An internal window blur must not change app presentation state or epoch.')

    const { fixture } = await seedAndPrepare(electron, page, { count: 2, periods: 320 }); seeded = true
    const instId = fixture.instIds[1], timeframe = '1H'
    await selectChart(page, instId, timeframe)
    const latestEnd = await page.evaluate(() => document.querySelector('[data-chart-inst]')?.__chartSnapshot?.endHour)
    await wheelBurst(page, { deltaY: 12 * 24 })
    await page.waitForFunction(({ instId, timeframe, latestEnd }) => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot, svg = chart?.querySelector('svg[data-rendered-inst]')
      return snapshot?.instId === instId && snapshot.timeframe === timeframe && snapshot.endHour < latestEnd
        && Number(svg?.dataset.renderedEnd) === snapshot.endHour && chart.dataset.chartLoading === 'false'
        && chart.dataset.chartVisualStale === 'false' && snapshot.indicatorState === 'ready'
    }, { instId, timeframe, latestEnd }, { timeout: 30_000 })
    const textbox = page.getByRole('textbox', { name: 'Search contracts' })
    await textbox.fill('SCALE001')
    await textbox.evaluate(input => input.setSelectionRange(2, 6))
    await page.waitForFunction(async () => (await window.radarDesktop.request({ preferences: { action: 'read' } })).chartTimeframe === '1H', null, { timeout: 10_000 })
    const preferencesBefore = await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'read' } }))
    const before = await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Search contracts"]'), chart = document.querySelector('[data-chart-inst]')
      const snapshot = chart.__chartSnapshot, svg = chart.querySelector('svg[data-rendered-inst]')
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input,
        selected: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour, bars: snapshot.bars,
        svg: svg.outerHTML, cacheStart: chart.dataset.chartCacheStart }
    })
    assert.equal(before.selected, instId); assert.equal(before.timeframe, timeframe); assert.ok(before.endHour < latestEnd)
    assert.equal(before.focused, true)
    const preparedBefore = await probe(electron, { action: 'preparedDiagnostics' })
    const key = `${instId}:${timeframe}`
    const cachedBefore = preparedBefore.series.find(series => series.key === key)
    assert.ok(cachedBefore?.history?.rows > 0, 'Historical source rows must be resident before simulated idle.')
    await installReadyRecorder(page); recorder = true
    const inactive = await setActive(electron, false)
    assert.equal(inactive.active, false)
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-presentation-idle'), null, { timeout: 20_000 })
    // Allow any already queued renderer work to settle, then count only real
    // changes and notifications while the fixed-rate source continues.
    await delay(1000)
    await page.evaluate(() => {
      const counters = window.__idleFunctionalCounts = { chartMutations: 0, listMutations: 0, notifications: 0 }
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.target instanceof Node && document.querySelector('[data-chart-panel]')?.contains(record.target)) counters.chartMutations++
          if (record.target instanceof Node && document.querySelector('[data-market-list]')?.contains(record.target)) counters.listMutations++
        }
      })
      observer.observe(document.querySelector('[data-chart-panel]'), { attributes: true, characterData: true, childList: true, subtree: true })
      observer.observe(document.querySelector('[data-market-list]'), { attributes: true, characterData: true, childList: true, subtree: true })
      const onNotification = () => { counters.notifications++ }
      const names = ['radar-chart-prepared', 'radar-market-changed', 'radar-audit-changed', 'radar-history-download-changed']
      names.forEach(name => window.addEventListener(name, onNotification))
      counters.stop = () => { observer.disconnect(); names.forEach(name => window.removeEventListener(name, onNotification)); return { chartMutations: counters.chartMutations, listMutations: counters.listMutations, notifications: counters.notifications } }
    })
    const background = await probe(electron, { action: 'backgroundStart' })
    assert.ok(background.writtenRecords > background.initialRows, 'Synthetic archive must have committed real SQLite rows before the idle observation.')
    const idleStart = Date.now()
    await probe(electron, { action: 'scaleLoadStart', ticks: 180, cadenceMS: 500, focusInstId: instId, timeframe })
    await delay(60_000)
    const idleElapsed = Date.now() - idleStart
    assert.ok(idleElapsed >= 60_000, 'The long idle must be at least 60 seconds of real wall time.')
    const loadDuring = await probe(electron, { action: 'scaleLoadRead' })
    assert.ok(loadDuring.emitted >= 100 && loadDuring.completed > 0 && loadDuring.state !== 'complete', 'The fixed-rate native source must advance throughout the idle and remain live for rapid toggles.')
    const counts = await page.evaluate(() => window.__idleFunctionalCounts.stop())
    assert.deepEqual(counts, { chartMutations: 0, listMutations: 0, notifications: 0 }, 'The idle renderer must keep its last presentation without continuing market notification delivery or DOM updates.')
    const idleView = await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Search contracts"]'), chart = document.querySelector('[data-chart-inst]'), snapshot = chart.__chartSnapshot
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input,
        selected: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour, bars: snapshot.bars,
        svg: chart.querySelector('svg[data-rendered-inst]').outerHTML, cacheStart: chart.dataset.chartCacheStart }
    })
    assert.deepEqual(idleView, before, 'The last DOM, input selection, selected contract, historical viewport and displayed bars must remain intact during idle.')
    const backgroundAfter = await probe(electron, { action: 'backgroundStatus' })
    assert.ok(backgroundAfter.archiveRows >= background.writtenRecords)
    if (background.writtenRecords < 12_240) assert.ok(backgroundAfter.archiveRows > background.writtenRecords, 'Archive work must continue while presentation is idle.')
    const latestLoadBeforeResume = await probe(electron, { action: 'scaleLoadRead' })
    assert.ok(latestLoadBeforeResume.emitted >= loadDuring.emitted)

    // Interleave activation changes without waiting for intermediate DOM acks;
    // source ticks keep arriving. The last epoch alone may claim readiness.
    const results = await electron.evaluate(async () => {
      const transitions = [true, false, true, false, true, false, true]
      const pending = []
      for (const active of transitions) {
        pending.push(globalThis.__presentationTest.setActive(active))
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      return Promise.all(pending)
    })
    const loadAfterToggles = await probe(electron, { action: 'scaleLoadRead' })
    assert.ok(loadAfterToggles.emitted > latestLoadBeforeResume.emitted, 'Source delivery must overlap the rapid activation changes.')
    const finalUpdate = results.at(-1)
    assert.equal(finalUpdate.active, true)
    assert.equal((await presentationState(electron)).epoch, finalUpdate.epoch)
    const historicalReady = await awaitReady(page, finalUpdate)
    assertReadyFrame(historicalReady, { instId, timeframe, historicalEnd: before.endHour })
    const after = await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Search contracts"]'), chart = document.querySelector('[data-chart-inst]'), snapshot = chart.__chartSnapshot
      return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input,
        selected: snapshot.instId, timeframe: snapshot.timeframe, endHour: snapshot.endHour, bars: snapshot.bars,
        svg: chart.querySelector('svg[data-rendered-inst]').outerHTML, cacheStart: chart.dataset.chartCacheStart }
    })
    assert.deepEqual(after, { value: before.value, start: before.start, end: before.end, focused: before.focused,
      selected: before.selected, timeframe: before.timeframe, endHour: before.endHour, bars: before.bars, svg: before.svg, cacheStart: before.cacheStart })
    const preferencesAfter = await page.evaluate(() => window.radarDesktop.request({ preferences: { action: 'read' } }))
    assert.deepEqual(preferencesAfter, preferencesBefore, 'Persisted preferences must survive the app presentation lifecycle.')
    const cachedAfter = (await probe(electron, { action: 'preparedDiagnostics' })).series.find(series => series.key === key)
    assert.ok(cachedAfter?.history?.rows >= cachedBefore.history.rows, 'Resident historical source rows must not be discarded on resume.')

    const load = await waitLoad(electron, value => value.state === 'complete', 45_000)
    assert.equal(load.completed, 180); assert.equal(load.failed, 0)
    const final = await probe(electron, { action: 'scaleStop' }); stopped = true
    assert.equal(final.ticks, 180); assert.equal(final.nativeUpdates, 180 * fixture.count * fixture.timeframes.length)
    assert.deepEqual(final.liveMismatches, [], 'Every native instrument/timeframe must retain the latest source value.')
    assert.equal(final.actualRows, fixture.rowsSeeded); assert.equal(final.minimumRowsPerSeries, fixture.periods)
    assert.ok(final.load.ticks.every(tick => tick.nativeUpdates === fixture.count * fixture.timeframes.length && !tick.error))
    // Return the historical viewport to the live edge, then force one more
    // activation so the promised ready marker itself must show the exact tail.
    await wheelBurst(page, { deltaY: -12 * 80 })
    const expected = expectedClose(fixture, instId, timeframe, final.ticks)
    await page.waitForFunction(({ instId, timeframe, expected }) => {
      const chart = document.querySelector('[data-chart-inst]'), snapshot = chart?.__chartSnapshot, svg = chart?.querySelector('svg[data-rendered-inst]')
      return snapshot?.instId === instId && snapshot.timeframe === timeframe && Math.abs(snapshot.liveBar?.close - expected) < 1e-8
        && Number(svg?.dataset.renderedEnd) === snapshot.liveBar.hour && chart.dataset.chartVisualStale === 'false' && chart.dataset.chartLoading === 'false'
    }, { instId, timeframe, expected }, { timeout: 30_000 })
    await setActive(electron, false)
    const update = await setActive(electron, true)
    const ready = await awaitReady(page, update)
    assertReadyFrame(ready, { instId, timeframe, expected,
      marketExpected: expectedClose(fixture, instId, '15m', final.ticks), marketCount: fixture.count })
    await removeReadyRecorder(page); recorder = false
    t.diagnostic(`SIMULATED APP activation; real idle ${idleElapsed} ms, ${loadDuring.emitted} emitted ticks; final DOM/RAF ${ready.latencyMS} ms; historical bars hash ${hash(before.bars)}. Physical screen/native focus latency unmeasured.`)
  } finally {
    if (recorder) await removeReadyRecorder(page).catch(() => {})
    if (seeded && !stopped) await probe(electron, { action: 'scaleStop' }).catch(() => {})
    await app.close()
  }
})
