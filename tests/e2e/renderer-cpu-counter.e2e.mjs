import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { startRendererCPUCounter } from '../../scripts/renderer-cpu-counter.mjs'

test('renderer CPU markers distinguish elapsed waiting from actual thread computation', { timeout: 30_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-renderer-cpu-'))
  let electron, counter
  try {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ monitoringPaused: true, backgroundMonitoringEnabled: false }))
    electron = await _electron.launch({ args: ['.'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: directory } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    counter = await startRendererCPUCounter(page, { label: 'protected-renderer-cpu' })
    await page.evaluate(async prefix => {
      let index = 0
      const mark = phase => console.timeStamp(prefix + JSON.stringify({ at: performance.now(), timeOrigin: performance.timeOrigin, phase, index: index++ }))
      mark('wait-start')
      await new Promise(resolve => setTimeout(resolve, 100))
      mark('wait-end')
      mark('busy-start')
      const deadline = performance.now() + 100
      while (performance.now() < deadline) {}
      mark('busy-end')
    }, counter.markerPrefix)
    const report = await counter.stop()
    assert.equal(report.complete, true, JSON.stringify(report.captureErrors))
    assert.equal(report.sampleCount, 4)
    assert.equal(report.droppedSamples, 0)
    const [waitStart, waitEnd, busyStart, busyEnd] = report.samples
    const waitingCPU = (waitEnd.metrics.ThreadTime - waitStart.metrics.ThreadTime) * 1_000
    const busyCPU = (busyEnd.metrics.ThreadTime - busyStart.metrics.ThreadTime) * 1_000
    assert.ok(waitEnd.at - waitStart.at >= 90)
    assert.ok(busyEnd.at - busyStart.at >= 90)
    assert.ok(busyCPU > 10, 'The busy renderer must consume measurable main-thread CPU.')
    assert.ok(waitingCPU < busyCPU, 'Elapsed waiting must not be reported as busy renderer CPU.')
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false)
    context.diagnostic(JSON.stringify({ waitingWallMS: waitEnd.at - waitStart.at, waitingCPU,
      busyWallMS: busyEnd.at - busyStart.at, busyCPU, artifact: report.artifact }))
  } finally {
    try { await counter?.stop() }
    finally { await electron?.close(); await rm(directory, { recursive: true, force: true }) }
  }
})
